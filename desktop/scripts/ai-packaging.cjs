const path = require("node:path");

function aiPackagingArgs(root) {
  const packages = [
    "deepagents", "langchain", "langchain_core", "langchain_openai", "langchain_anthropic",
    "langgraph", "langsmith", "wcmatch", "bracex",
    "pypdf", "pypdfium2", "pypdfium2_raw", "tiktoken", "docx", "pptx", "openpyxl",
    "onnxruntime", "tokenizers", "sqlite_vec", "huggingface_hub"
  ];
  const args = packages.flatMap((name) => ["--collect-all", name]);
  for (const name of [
    "local_search_models.json",
    "local_search_gpu.json",
    "insight_local_model.json",
    "voice_models.json",
    "contact_region_lookup.json"
  ]) {
    const full = path.join(root, "src", "wechat_decrypt_tool", "resources", name);
    args.push("--add-data", `${full}${path.delimiter}wechat_decrypt_tool/resources`);
  }
  const lic = path.join(root, "src", "wechat_decrypt_tool", "resources", "licenses");
  args.push("--add-data", `${lic}${path.delimiter}wechat_decrypt_tool/resources/licenses`);
  const htmlExport = path.join(root, "src", "wechat_decrypt_tool", "resources", "html_export");
  args.push("--add-data", `${htmlExport}${path.delimiter}wechat_decrypt_tool/resources/html_export`);
  args.push("--collect-submodules", "tiktoken_ext", "--hidden-import", "langgraph.checkpoint.sqlite.aio");
  return args;
}

module.exports = { aiPackagingArgs };
