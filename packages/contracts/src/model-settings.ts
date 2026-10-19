export const modelVendors = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    portal: "https://platform.deepseek.com/api_keys",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6.1-sol",
    models: ["gpt-6.1-sol", "gpt-6-astra"],
    portal: "https://platform.openai.com/api-keys",
  },
  qwen: {
    label: "通义千问（阿里云）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-flash",
    models: ["qwen3.8-flash", "qwen-plus"],
    portal: "https://bailian.console.aliyun.com/",
  },
} as const;
export type ModelVendor = keyof typeof modelVendors;
export type PersonalModelSettings = {
  vendor: ModelVendor;
  model: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
};
export type PersonalModelState = {
  enabled: boolean;
  configured: boolean;
  settings: PersonalModelSettings | null;
  revision: string | null;
  updatedAt: string | null;
  active: boolean;
};
