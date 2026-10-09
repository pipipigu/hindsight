/** Instructions owned by the plugin, separate from untrusted historical evidence. */
export const MEMORY_SEARCH_GUIDE =
  "处理项目问题时，必须先主动查询 Hindsight：用 hindsight_search_knowledge_pages 搜索知识专题、hindsight_search_observations 搜索归纳记忆、hindsight_recall 查询具体事实，或直接调用 hindsight_reflect 委托云端整理。完成主动查询后，才能搜索或读取本地文件与代码（包括 glob、rg、grep、find、read 和通过 bash 执行的文件查询），核验当前实现。自动召回不替代主动查询；本轮已查询无需重复。记忆工具不可用或查询失败时，说明原因后再查本地。";
