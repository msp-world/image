/**
 * 生图工作台 MSP World（移植自 cortico-world-image）：
 * - 支持本地 ComfyUI 与云端 OpenAI 兼容端点链式兜底
 * - 工具：image_models, image_draw, image_edit, image_gallery
 * - 信号：image.generated
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolResult, blobRef, imageContent, type MSPNode } from "../shared/msp.ts";

export interface ImageModelEntry {
  name: string;
  kind: "comfyui" | "openai";
  baseUrl: string;
  apiKey?: string;
  model?: string;
  defaultSize?: string;
}

export interface ImageWorldConfig {
  outputDir: string;
  models: ImageModelEntry[];
  timeoutMs?: number;
}

export interface GalleryRecord {
  id: string;
  path: string;
  model: string;
  prompt: string;
  createdAt: string;
  byteLength: number;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function parseSize(size?: string): { width: number; height: number; sizeStr: string } {
  const s = (size ?? "1024x1024").trim().toLowerCase();
  if (s === "portrait" || s === "9:16") return { width: 768, height: 1344, sizeStr: "1024x1536" };
  if (s === "landscape" || s === "16:9") return { width: 1344, height: 768, sizeStr: "1536x1024" };
  if (s === "4:3") return { width: 1152, height: 896, sizeStr: "1024x1024" };
  if (s === "square" || s === "1:1") return { width: 1024, height: 1024, sizeStr: "1024x1024" };
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (m) return { width: Number(m[1]), height: Number(m[2]), sizeStr: `${m[1]}x${m[2]}` };
  return { width: 1024, height: 1024, sizeStr: "1024x1024" };
}

export class ImageWorld {
  private readonly cfg: Required<ImageWorldConfig>;
  private readonly fetchImpl: FetchImpl;
  private readonly gallery: GalleryRecord[] = [];
  private node: MSPNode | null = null;
  private seq = 1;

  constructor(config: ImageWorldConfig, fetchImpl?: FetchImpl) {
    this.cfg = {
      outputDir: config.outputDir,
      models: config.models,
      timeoutMs: config.timeoutMs ?? 60_000,
    };
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    fs.mkdirSync(this.cfg.outputDir, { recursive: true });
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("image.generated", "生图或改图完成事件");

    node.tool(
      "image_models",
      "列出已配置的生图模型链（ComfyUI / OpenAI 兼容）及其就绪状态",
      () => ({
        models: this.cfg.models.map((m) => ({
          name: m.name,
          kind: m.kind,
          baseUrl: m.baseUrl,
          ready: Boolean(m.baseUrl && (m.kind === "comfyui" || m.apiKey)),
        })),
      }),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "image_draw",
      "按文字描述生图（按模型链顺序尝试），落盘并返回绝对路径",
      async (args) => this.draw(args),
      {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          size: { type: "string" },
          negative: { type: "string" },
          steps: { type: "integer" },
          cfg: { type: "number" },
          seed: { type: "integer" },
          includeBase64: { type: "boolean", default: false },
        },
      },
    );

    node.tool(
      "image_edit",
      "基于已有本地图片按指令改图（支持 OpenAI /images/edits 或 ComfyUI）",
      async (args) => this.edit(args),
      {
        type: "object",
        required: ["prompt", "image"],
        properties: {
          prompt: { type: "string" },
          image: { type: "string", description: "图片绝对路径或 gallery id" },
          model: { type: "string" },
          size: { type: "string" },
          includeBase64: { type: "boolean", default: false },
        },
      },
    );

    node.tool(
      "image_gallery",
      "列出最近生成的图片作品记录",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 50) : 10;
        return { total: this.gallery.length, items: this.gallery.slice(-limit).reverse() };
      },
      { type: "object", properties: { limit: { type: "integer", default: 10 } } },
    );

    node.skill({
      name: "draw_and_refine",
      summary: "先查看模型链就绪状态，再生图或基于作品 ID 改图",
      whenToUse: "用户要求画新图、调整已有图片或排查模型配置时使用",
      toolsUsed: ["image_models", "image_draw", "image_edit", "image_gallery"],
    });
  }

  private pickModels(named?: string): ImageModelEntry[] {
    if (named) {
      const found = this.cfg.models.find((m) => m.name === named);
      if (!found) throw new Error(`未找到模型配置: ${named}`);
      return [found];
    }
    if (this.cfg.models.length === 0) throw new Error("未配置任何生图模型");
    return this.cfg.models;
  }

  private async draw(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt 不能为空");
    const candidates = this.pickModels(typeof args.model === "string" ? args.model : undefined);
    const { width, height, sizeStr } = parseSize(typeof args.size === "string" ? args.size : undefined);

    const errors: string[] = [];
    for (const m of candidates) {
      try {
        const bytes =
          m.kind === "openai"
            ? await this.drawOpenAi(m, prompt, sizeStr)
            : await this.drawComfyUi(m, prompt, {
                width,
                height,
                negative: typeof args.negative === "string" ? args.negative : "",
                steps: typeof args.steps === "number" ? args.steps : 20,
                cfg: typeof args.cfg === "number" ? args.cfg : 7,
                seed: typeof args.seed === "number" ? args.seed : Math.floor(Math.random() * 1e9),
              });
        return this.saveAndEmit(bytes, m.name, prompt, args.includeBase64 === true);
      } catch (err) {
        errors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`所有生图模型均失败: ${errors.join("; ")}`);
  }

  private async edit(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = String(args.prompt ?? "").trim();
    const rawImg = String(args.image ?? "").trim();
    const fromGallery = this.gallery.find((g) => g.id === rawImg);
    const imgPath = fromGallery ? fromGallery.path : rawImg;
    if (!fs.existsSync(imgPath)) throw new Error(`源图片不存在: ${imgPath}`);
    const srcBytes = fs.readFileSync(imgPath);
    const candidates = this.pickModels(typeof args.model === "string" ? args.model : undefined);
    const { sizeStr } = parseSize(typeof args.size === "string" ? args.size : undefined);

    const errors: string[] = [];
    for (const m of candidates) {
      try {
        if (m.kind !== "openai") throw new Error("当前改图链仅支持 OpenAI 兼容端点");
        const form = new FormData();
        form.append("prompt", prompt);
        form.append("size", sizeStr);
        if (m.model) form.append("model", m.model);
        form.append("image", new Blob([srcBytes], { type: "image/png" }), path.basename(imgPath));

        const url = `${m.baseUrl.replace(/\/+$/, "")}/images/edits`;
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {},
          body: form,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as any;
        const b64 = json?.data?.[0]?.b64_json;
        if (!b64) throw new Error("响应缺少 b64_json");
        return this.saveAndEmit(Buffer.from(b64, "base64"), m.name, prompt, args.includeBase64 === true);
      } catch (err) {
        errors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`改图失败: ${errors.join("; ")}`);
  }

  private async drawOpenAi(m: ImageModelEntry, prompt: string, size: string): Promise<Uint8Array> {
    const url = `${m.baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: m.model || "gpt-image-1",
        prompt,
        size,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const b64 = json?.data?.[0]?.b64_json;
    if (typeof b64 === "string") return Buffer.from(b64, "base64");
    const imgUrl = json?.data?.[0]?.url;
    if (typeof imgUrl === "string") {
      const imgRes = await this.fetchImpl(imgUrl, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      if (!imgRes.ok) throw new Error(`下载图片失败 HTTP ${imgRes.status}`);
      return new Uint8Array(await imgRes.arrayBuffer());
    }
    throw new Error("响应缺少 b64_json 或 url");
  }

  private async drawComfyUi(
    m: ImageModelEntry,
    promptText: string,
    opts: { width: number; height: number; negative: string; steps: number; cfg: number; seed: number },
  ): Promise<Uint8Array> {
    const base = m.baseUrl.replace(/\/+$/, "");
    const workflow = {
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: opts.seed,
          steps: opts.steps,
          cfg: opts.cfg,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["5", 0],
        },
      },
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: m.model || "model.safetensors" } },
      "5": { class_type: "EmptyLatentImage", inputs: { width: opts.width, height: opts.height, batch_size: 1 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: promptText, clip: ["4", 1] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: opts.negative, clip: ["4", 1] } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "msp", images: ["8", 0] } },
    };
    const submit = await this.fetchImpl(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!submit.ok) throw new Error(`ComfyUI /prompt HTTP ${submit.status}`);
    const { prompt_id } = (await submit.json()) as { prompt_id: string };
    const deadline = Date.now() + this.cfg.timeoutMs;
    while (Date.now() < deadline) {
      const histRes = await this.fetchImpl(`${base}/history/${encodeURIComponent(prompt_id)}`);
      if (histRes.ok) {
        const hist = (await histRes.json()) as any;
        const entry = hist?.[prompt_id];
        const img = entry?.outputs?.["9"]?.images?.[0];
        if (img?.filename) {
          const viewRes = await this.fetchImpl(
            `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}&type=${encodeURIComponent(img.type ?? "output")}`,
          );
          if (!viewRes.ok) throw new Error(`ComfyUI /view HTTP ${viewRes.status}`);
          return new Uint8Array(await viewRes.arrayBuffer());
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("ComfyUI 生图超时");
  }

  private saveAndEmit(
    bytes: Uint8Array,
    model: string,
    prompt: string,
    includeBase64: boolean,
  ): ToolResult {
    const id = `img-${this.seq++}`;
    const filePath = path.join(this.cfg.outputDir, `${id}-${Date.now()}.png`);
    fs.writeFileSync(filePath, bytes);
    const rec: GalleryRecord = {
      id,
      path: filePath,
      model,
      prompt,
      createdAt: new Date().toISOString(),
      byteLength: bytes.byteLength,
    };
    this.gallery.push(rec);
    if (this.gallery.length > 100) this.gallery.shift();
    this.node?.publish("image.generated", { ...rec });
    const blocks = [
      blobRef(filePath, "image/png", bytes.byteLength),
      ...(includeBase64 ? [imageContent(Buffer.from(bytes).toString("base64"), "image/png")] : []),
    ];
    return new ToolResult(blocks, { ...rec, mime: "image/png" });
  }
}
