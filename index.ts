import * as os from "node:os";
import * as path from "node:path";
import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { ImageWorld, type ImageModelEntry } from "./world.ts";

export async function startImageNode(): Promise<{ node: MSPNode; world: ImageWorld }> {
  const node = new MSPNode(process.env.IMAGE_NODE_ID || "image", mspOptionsFromEnv("IMAGE"));
  const models: ImageModelEntry[] = [];
  if (process.env.COMFYUI_URL) {
    models.push({
      name: "comfyui",
      kind: "comfyui",
      baseUrl: process.env.COMFYUI_URL,
      model: process.env.COMFYUI_CKPT || undefined,
    });
  }
  if (process.env.IMAGE_OPENAI_URL && process.env.IMAGE_OPENAI_KEY) {
    models.push({
      name: "cloud",
      kind: "openai",
      baseUrl: process.env.IMAGE_OPENAI_URL,
      apiKey: process.env.IMAGE_OPENAI_KEY,
      model: process.env.IMAGE_OPENAI_MODEL || "gpt-image-1",
    });
  }
  const world = new ImageWorld({
    outputDir: process.env.IMAGE_OUTPUT_DIR || path.join(os.tmpdir(), "msp-images"),
    models,
  });
  world.attach(node);
  const ep = await node.start();
  console.log(`[image] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node } = await startImageNode();
  installShutdownHooks(() => node.stop());
}
