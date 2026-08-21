# 07 vendor/ — Cordis 框架

> `vendor/` 是钉住版本、rescope 为 `@deepseek-ai/*` 的 Cordis 框架及配套库源码副本，让 harness 完全拥有可审计、可 patch 的框架层。

## 1. vendoring 政策

- 每个包是上游某 commit 的源码拷贝；`vendor/README.md` 内的 manifest 记录上游名称、版本、仓库与 commit SHA。
- 更新走 `vendor/README.md` 中的 sync 程序；已记录的本地修改需重新应用或废弃，然后 `pnpm run test && pnpm run build`。
- 修改 `vendor/*/src` 必须与 manifest 更新一起暂存（pre-commit 的 vendor manifest guard 强制）。
- rescope：`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 经 `pnpm-workspace.yaml` 的 `overrides` 钉到本地源码；`@deepseek-ai/cordis` 是**每个** harness 包的 peerDependency (+dev)。`scripts/rescope-vendor.ts`（`pnpm run rescope-vendor[:check]`）负责改名与校验。

| vendored 包 | 上游 | 职责 |
|---|---|---|
| `cordis` | cordiverse/cordis | 框架本体（下详） |
| `cosmokit` | cordiverse/cosmokit | 零依赖工具库（array/string/time/misc/types） |
| `schemastery` | cordiverse/schemastery | 声明式配置 schema（`z` 构造器，各包 `Config` 用） |
| `loader` | cordiverse/loader | cordis.yml 配置加载器（entry/group/isolate/tree） |
| `include` | — | include 机制 |
| `group` | cordiverse-group | 分组插件（`@deepseek-ai/cordis-plugin-group`，web 前端依赖） |
| `hmr` | — | 热替换（本地增强在 `cordis/src/fiber.ts`） |
| `logger-console` | — | 控制台 logger（browser/shared 两实现） |
| `timer` | — | 定时器 |

## 2. Cordis 核心概念（`vendor/cordis/src/`）

### Context（`context.ts`）

- 聚合 `events` / `logger` / `reflect` / `registry` 四服务；通过 `new Proxy` + `ReflectService` 把服务解析成属性访问（`ctx.sessions` → 服务 store 查询）。
- `extend()` — 派生上下文；`isolate()` — 服务隔离（同名服务在不同 isolate realm 各自实例）；`intercept()` — 插件配置拦截。
- 声明合并入口：包内 `declare module '@deepseek-ai/cordis' { interface Context { ... } interface Events { ... } }` 把服务键与事件类型并入全局（这正是 Host/Client 双聚合的原因：两侧对同名键合并不同服务）。

### Registry 与插件（`registry.ts`）

- `Plugin` 形态：function / class / object 插件，携带 `name` / `inject`（服务依赖，声明后等待就绪）/ `provide` / `intercept` / `Config` 等元数据。
- `ctx.plugin(plugin, config)` — 挂载插件，返回 `Fiber & PromiseLike<Fiber>`；`ctx.inject(deps, callback)` — 声明服务依赖后回调。

### 事件系统（`events.ts`）

`DispatchMode` 五种：`emit` / `parallel` / `serial` / `bail` / `waterfall`。`EventsService.dispatch()` 实现过滤、顺序执行、bail 判断与 waterfall 的 `next` 链式委托（不调 `next()` 即短路——dsh 的 `agent/pre-step`、`tools/*`、`llm/stream`、`system-prompt/assemble` 都依赖此语义）。

### Service 与 Fiber（`service.ts` / `fiber.ts`）

- `Service` 基类：构造时经 `ctx.reflect.provide()` 注册到当前 context，所属 fiber 卸载时自动移除——"注册即效果"的框架根基。
- `Fiber`：插件生命周期单元（状态机 `FiberState`：含 `UNLOADING` / `DISPOSED` / `FAILED` 等非活跃态，agent-loop 的 `FactoryOwnership` 据此判断可否受理新生命周期）。

### 运行入口

`vendor/cordis/bin.js`：创建 root `Context`、挂载 Loader、加载 `./cordis.yml`——教程与 examples 即用此入口直接驱动插件树。

## 3. loader（`vendor/loader/src/`）

cordis.yml 配置模型（dsh 的 profile/bundle 体系建立在其上）：

- `config/entry.ts` — 配置行（插件名 + `config` + `disabled`；`config` 与 `disabled` 允许 `!!js` 表达式，其余元数据保持字面量）。
- `config/group.ts` / `config/isolate.ts` / `config/tree.ts` — 分组、服务隔离 realm、树形结构。
- dsh 约束：Raw/Web `cordis.yml` 的裸插件必须出现在其解析器 manifest 的 `dependencies`，`verify-cordis-config` 强制。

## 4. dsh 如何使用 Cordis（速查）

| 用法 | 示例 |
|---|---|
| 服务定义 | `class SessionStore extends Service` + `declare module` 合并 `Context` |
| 函数插件 | 具名导出 `name` / `inject` / `Config` / `apply`（无默认导出——混用会丢命名空间，见 postmortem 0001） |
| 可选服务 | `ctx.get(name)`；`ctx.<name>` 保留给声明的注入 |
| 作用域 | dsh-scope 的 `agent.ctx`（Cordis `extend`/`isolate` 之上） |
| 配置 schema | `z`（schemastery）声明 `Config`，settings UI 与 config catalog 由其生成 |
