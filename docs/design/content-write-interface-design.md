# Content Write 接口设计

## 背景

OpenViking 现有的语义增量更新链路，核心由 `SemanticMsg.changes` 和 `SemanticDagExecutor` 驱动。此前缺少的是一个一等公民的 `write` 接口，用来编辑一个已经存在的文件，同时还要保持以下能力：

- 租户隔离
- 仅允许文件写入的语义约束
- 可选的语义重新生成
- 可选的向量重新写入
- 尽量复用已有的增量更新逻辑，而不是再发明一套平行流水线

本文描述本次实现采用的设计。

## 目标

- 增加一个只面向已存在文件的 `write` 接口，目录必须被拒绝。
- 支持 `replace` 和 `append`。
- 至少支持 `resource`、`memory` 和 `skill`。
- 在适配的前提下，尽量复用现有语义增量更新机制。
- 保留租户权限校验，避免跨租户路径信息泄露。
- 允许调用方自行选择是否重新生成语义，以及是否重新写入向量。

## 非目标

- 不支持创建新文件或新目录。
- 不支持直接编辑派生语义文件：`.abstract.md`、`.overview.md`、`.relations.json`。
- 不追求一次性覆盖所有内部 scope。当前首版聚焦于：
  - `viking://resources/...`
  - `viking://user/.../memories/<type>/...`
  - `viking://agent/.../memories/<type>/...`
  - `viking://agent/skills/<skill>/...`

## API 形态

HTTP 接口：

- `POST /api/v1/content/write`

请求字段：

- `uri: str`
- `content: str`
- `mode: "replace" | "append"`，默认 `replace`
- `regenerate_semantics: bool`，默认 `true`
- `revectorize: bool`，默认 `true`
- `wait: bool`，默认 `false`
- `timeout: Optional[float]`
- `telemetry`

返回字段：

- `uri`
- `root_uri`
- `context_type`
- `mode`
- `written_bytes`
- `semantic_updated`
- `vector_updated`
- 当 `wait=true` 时返回 `queue_status`

客户端侧也同步补齐了统一入口，包括：

- Python 异步 HTTP client
- Python 同步 HTTP client
- embedded/local client
- `AsyncOpenViking`
- Rust CLI

## 校验规则

`write` 在真正执行写入前会先校验目标：

- URI 必须存在。
- URI 必须是文件，不能是目录。
- `mode` 必须是 `replace` 或 `append`。
- 派生语义文件不允许直接写入。
- scope 必须能够落到当前支持的根节点范围内。

## 租户与权限模型

所有文件系统操作都运行在调用方提供的 `RequestContext` 下。

关键性质如下：

- `stat`、`read`、`write_file`、`append_file`、temp copy、队列消息构造以及最终 sync，全部沿用同一个带租户语义的 `ctx`。
- 因而跨租户写入会在文件系统层直接失败。
- 协调器在探测目标时，会有意将非预期访问失败映射为 `NotFoundError`，从而避免暴露外部租户路径是否真实存在。
- subtree lock 是基于解析出的根节点，并在调用方上下文中获取，因此语义刷新和最终 sync 也处在相同租户边界内。

这与 OpenViking 现有的多租户行为保持一致，而不是在 `write` 里再引入第二套权限系统。

## 根节点解析

write 协调器会从目标文件 URI 反推出一个语义刷新根节点：

- `resources`：根节点是最上层 resource 节点，例如 `viking://resources/foo`
- `user/.../memories/<type>/...`：根节点是 memory type 目录
- `agent/.../memories/<type>/...`：根节点是 memory type 目录
- `agent/skills/<skill>/...`：根节点是 skill 目录

这个根节点就是：

- 父目录语义向上更新的作用范围
- subtree lock 的加锁范围

## Write 模式

### 1. 不重新生成语义的直接写入

当 `regenerate_semantics=false` 时：

1. 直接原地写目标文件。
2. 如果 `revectorize=true`，则只对这个被修改的文件单独执行 `vectorize_file(...)`。
3. 不更新父目录的 `.overview.md` 和 `.abstract.md`。

这是代价最低的模式，适合调用方只需要改原始内容、不关心父目录语义刷新的场景。

### 2. 需要重新生成语义的 Resource / Skill 写入

对于 `resource` 和 `skill`，本实现尽可能复用了现有的增量更新链路：

1. 解析语义根节点。
2. 对目标根节点加 subtree lifecycle lock。
3. 将整个根子树复制到一个 temp URI。
4. 在 temp 子树内应用文件修改。
5. 构造一个 `SemanticMsg` 入队，其中包含：
   - `uri=temp_root_uri`
   - `target_uri=original_root_uri`
   - `changes={"modified": [temp_target_uri]}`
   - `skip_vectorization=not revectorize`
   - `lifecycle_lock_handle_id=<subtree lock>`
6. 由 `SemanticDagExecutor` 以 incremental 模式运行。
7. 等语义和 embedding 处理完成后，通过 `_sync_topdown_recursive()` 对 temp 和 target 做 diff，再只把变化的文件/目录同步回目标树。

这条路径直接复用了之前已经存在的增量 DAG 逻辑。

## 父目录是怎么更新的

父目录的更新并不是在本地手工拼一个完整 overview 字符串。当前流水线的工作方式是：

- 对变更文件，重新调用 VLM 或已有的单文件摘要逻辑，生成新的 file summary。
- 在增量更新模式下，对未变文件，会通过解析当前父目录的 `.overview.md` 来复用旧摘要。
- 对变更目录，会重新调用 `_generate_overview(...)`。这一步仍然是基于 LLM/VLM 的目录级摘要生成，输入包括：
  - 当前文件摘要集合
  - 子目录 abstract 集合
- overview 生成之后，再通过 `_extract_abstract_from_overview(...)` 从 overview 文本中本地提取 `.abstract.md`。

因此答案是：

- `overview` 的生成仍然是模型驱动的。
- `abstract` 不是再单独调用一次模型生成，而是从 overview 中本地提取。

增量更新时也是同样的原理。所谓“增量”，本质上是尽量避免重算未变化节点，以及避免把未变化内容重新写回目标树，而不是换了一套新的父目录生成方式。

## 增量更新复用的细节

已有的增量更新行为，已经提供了本次 `write` 所需的大部分基础设施：

- `SemanticMsg.changes` 用来标记被修改的文件。
- `SemanticDagExecutor._check_file_content_changed(...)` 用来比较 temp 和 target 的文件内容是否变化。
- 未变化文件会从目标树现有 `.overview.md` 中复用已有摘要。
- 未变化目录会复用目标树现有 `.overview.md` 和 `.abstract.md`。
- 变化目录会重新生成 overview/abstract。
- `_sync_topdown_recursive(...)` 只把差异部分从 temp 推回 target。

本次 `write` 设计的核心，就是把写操作接入到这条现有流水线，而不是重新实现一套父节点传播逻辑。

## 为什么 Memory 走了不同路径

`memory` 目前在 `SemanticProcessor._process_memory_directory(...)` 里已经有一条专用语义处理链路。

它的当前行为是：

- 在 memory 目录上原地处理
- 可以通过解析现有 `.overview.md` 来复用未变化文件的摘要
- 只对变化的 memory 文件重新生成摘要
- 通过 `_generate_overview(...)` 重新生成目录级 overview
- 从 overview 中本地提取 abstract
- 对 memory 目录的 `.abstract.md` 和 `.overview.md` 做向量化

问题在于，这条链路本身并不依赖 `target_uri + temp-root sync` 模式，而是直接在原目录工作。因此在不做更大范围重构之前，memory 不能安全复用 resource/skill 那套 temp subtree 流程。

所以当前实现对 memory 的处理是：

1. 对 memory type 目录加 subtree lock。
2. 原地写目标 memory 文件。
3. 如果 `revectorize=true`，立刻对这个被改的 memory 文件本身重新做向量化。
4. 以 `changes={"modified": [file_uri]}` 为输入，对 memory 目录入队一次语义刷新。
5. 由 `_process_memory_directory(...)` 更新 `.overview.md` 和 `.abstract.md`。
6. 继续复用现有目录级向量化逻辑，把这些派生语义文件重新写入向量库。

这样做的好处是：虽然 memory 没有直接走 temp-root sync，但它仍然复用了自己现有的增量摘要复用机制，并与当前 memory 架构保持一致。

## 向量数据库写回

向量写回在两条路径中都被显式考虑了。

### `regenerate_semantics=false`

- 如果 `revectorize=true`，只对被修改文件本身重新做 embedding。

### `regenerate_semantics=true` 且为 resource / skill

- 变化文件的摘要会由 `SemanticDagExecutor` 调度文件级向量化。
- 变化目录会调度 `.abstract.md` 和 `.overview.md` 的向量化。
- 当 `skip_vectorization=true` 时，DAG 仍然会更新语义文件，但不会投递 embedding 任务。

### `regenerate_semantics=true` 且为 memory

- 被修改的 memory 文件本身可以立刻重新做 embedding。
- 随后 `_process_memory_directory(...)` 会对重新生成的 `.abstract.md` 和 `.overview.md` 执行目录级向量化。
- 本次还补了一个小修复，确保 memory lifecycle lock 在早返回、异常和成功路径上都能被释放。

## 锁设计

本设计复用了现有 subtree lifecycle lock，目的是保证：

- 同一根节点下的语义刷新不会和其他修改竞争
- 锁的生命周期覆盖后台队列处理，而不仅仅是最初的 HTTP 请求
- resource/skill 的增量 DAG，以及 memory 的刷新流程，都会在后台处理结束后释放锁

对于 memory，本次额外增加了显式的 lock release helper，因为原地处理路径中存在多个 early return 分支。

## 错误语义

- 非法 mode 或不支持的 scope：`InvalidArgumentError`
- 目标 URI 是目录：`InvalidArgumentError`
- 目标 URI 是派生语义文件：`InvalidArgumentError`
- 目标不存在或无权限访问：`NotFoundError`
- 等待队列完成超时：`DeadlineExceededError`

## 考虑过的替代方案

### 对所有 context type 都采用原地重建

不采用。因为 resource/skill 已经有一套成熟的 temp-root incremental DAG + sync 路径；再原地重做一遍，只会带来逻辑重复和更高的不一致风险。

### 强行把 memory 接到 temp-root sync 路径上

当前也不采用。因为现有 memory 语义处理是原地执行的，并不使用 `target_uri`。如果强行改过去，就需要对 memory processor 做一轮更大的重构。

## 后续可选演进

- 如果后续需要，可以继续把 memory 统一到 DAG temp-root 模型，让 memory processor 也理解 `target_uri`。
- 可以在本地可稳定绑定 live HTTP server 的环境里，补充 SDK/CLI 层面的 `write` 测试。
- 如果后续有清晰的 ownership 和权限语义，也可以再扩展到更多 scope。

## 关键代码入口

- `openviking/server/routers/content.py`
- `openviking/service/fs_service.py`
- `openviking/service/content_write_coordinator.py`
- `openviking/storage/queuefs/semantic_processor.py`
- `openviking/storage/queuefs/semantic_dag.py`
