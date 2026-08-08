// Agent 生成工具契约：真实模型 ID 与固定参数值必须直接下发给模型，不能让模型猜。
// 用法：npx tsx agent-tools-contract-check.ts（在 server/ 目录）
import { readFileSync } from "node:fs";

import {
  listAgentTools,
  type AgentToolAccess,
} from "./src/services/agent-tools";
import type { PublicSetting } from "./src/services/settings";

let pass = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : `\n       实际 ${JSON.stringify(actual)}\n       期望 ${JSON.stringify(expected)}`}`,
  );
  ok ? (pass += 1) : (failed += 1);
}

const access: AgentToolAccess = {
  search: false,
  image: true,
  video: true,
  audio: true,
  text: true,
  vision: false,
};
const settings = {
  modelChannel: {
    models: [
      {
        name: "gpt",
        label: "GPT 文本",
        apiFormat: "openai",
        capability: "text",
        vision: false,
      },
      {
        name: "gpt-image-2",
        label: "GPT Image 2",
        apiFormat: "openai",
        capability: "image",
        vision: false,
      },
      {
        name: "image-backup",
        label: "备用生图",
        apiFormat: "openai",
        capability: "image",
        vision: false,
      },
      {
        name: "video-1",
        label: "视频模型",
        apiFormat: "openai",
        capability: "video",
        vision: false,
      },
      {
        name: "tts-1",
        label: "语音模型",
        apiFormat: "openai",
        capability: "audio",
        vision: false,
      },
    ],
    modelCosts: [],
    defaultModel: "gpt",
    defaultImageModel: "gpt-image-2",
    defaultVideoModel: "video-1",
    defaultTextModel: "gpt",
    defaultAudioModel: "tts-1",
    systemPrompt: "",
    allowCustomChannel: true,
  },
  auth: {
    allowRegister: true,
    requireInvite: false,
    linuxDo: { enabled: false },
    turnstile: {
      siteKey: "",
      loginEnabled: false,
      registerEnabled: false,
      oauthCompleteEnabled: false,
    },
  },
  storage: { remoteEnabled: true, defaultQuota: 1 },
  team: { defaultQuota: 1, maxPerUser: 1 },
  capabilities: { image: true, video: true, text: true, audio: true },
  agent: {
    enabled: true,
    model: "gpt",
    titleModel: "",
    maxRounds: 25,
    searchEnabled: false,
  },
} satisfies PublicSetting;

const tools = listAgentTools(access, settings);
const tool = (name: string) => {
  const item = tools.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`缺少工具：${name}`);
  return item;
};
const property = (toolName: string, name: string) =>
  tool(toolName).parameters.properties[name] as Record<string, unknown>;

console.log("Agent 可用模型目录");
check(
  "生图只暴露 image 能力的真实模型 ID",
  property("generate_image", "model").enum,
  ["gpt-image-2", "image-backup"],
);
check("文本生成不混入生图模型", property("generate_text", "model").enum, [
  "gpt",
]);
check("视频生成暴露实际视频模型", property("generate_video", "model").enum, [
  "video-1",
]);
check("语音生成暴露实际语音模型", property("generate_audio", "model").enum, [
  "tts-1",
]);
check(
  "模型说明包含展示名与真实 ID",
  String(property("generate_image", "model").description).includes(
    "GPT Image 2 (gpt-image-2)",
  ),
  true,
);

console.log("Agent 生图参数目录");
check("画质合法值完整下发", property("generate_image", "quality").enum, [
  "auto",
  "high",
  "medium",
  "low",
]);
check("背景合法值完整下发", property("generate_image", "background").enum, [
  "transparent",
  "opaque",
]);
check("生成张数下限", property("generate_image", "count").minimum, 1);
check("生成张数上限", property("generate_image", "count").maximum, 4);
check(
  "生图工具可直接设置节点标题",
  Boolean(property("generate_image", "title")),
  true,
);
check(
  "尺寸说明包含常用值与自定义格式",
  /1024x1024/.test(String(property("generate_image", "size").description)) &&
    /宽x高/.test(String(property("generate_image", "size").description)),
  true,
);

console.log("默认模型能力修复契约");
const settingsSource = readFileSync(
  new URL("./src/services/settings.ts", import.meta.url),
  "utf8",
);
const repairBlock = settingsSource.slice(
  settingsSource.indexOf("function repairDefaultModel"),
  settingsSource.indexOf("function normalizeSearchService"),
);
check(
  "默认模型必须同时匹配名称和 capability",
  /model\.name\s*===\s*value\s*&&\s*model\.capability\s*===\s*capability/.test(
    repairBlock,
  ),
  true,
);

console.log(`\n通过 ${pass}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
