# SDC 约束审查

一个用于解析、绑定、合并和解释三层简化 SDC 约束的 Node.js/Vite 应用。它不执行商业 STA；关注点是对象集合命中、约束遮蔽、generated clock 派生、multicycle 关联、日期到期例外和发布前 endpoint 差异。

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev -- --host 127.0.0.1 --port 5355 --strictPort
```

页面地址：<http://127.0.0.1:5355>

`pnpm dev` 使用 Vite middleware 在同一个 5355 端口提供静态页面和 `/api/*` JSON 接口。SQLite 数据库默认位于 `data/sdc.sqlite`，可用 `SDC_DB_PATH` 覆盖。

## 语法子集

支持行注释、反斜杠续行、双引号、大括号和一层或多层集合表达式：

```sdc
create_clock -name clk -period 10.0 [get_ports CLK]

create_generated_clock -name pll_clk \
  -source [get_pins U_PLL/clkout] \
  -master_clock clk \
  -divide_by 2 \
  [get_pins U_PLL/clkout]

set_input_delay 2.0 -clock clk -max [get_ports DIN\[\*\]]
set_output_delay 1.5 -clock clk -max [get_ports DOUT\[\*\]]

set_false_path -from [get_pins U/A/q] -through [get_pins M/y] -to [get_pins U/B/d]
set_multicycle_path 2 -setup -from [get_pins U/A/q] -to [get_pins U/B/d]
set_multicycle_path 1 -hold -from [get_pins U/A/q] -to [get_pins U/B/d]
```

支持的集合命令：

- `get_ports`
- `get_cells`
- `get_pins`
- `get_objects`：同时在 port、cell、pin 索引中查找

支持的 generated clock 派生选项是 `-divide_by` 和 `-multiply_by`。未列入本 README 的 SDC 命令或选项会产生结构化 warning，而不会按文件顺序伪装成同类约束。

## 层次名与转义

层次分隔符固定为 `/`。裸 token 中使用反斜杠转义元字符和空格：

| 模式片段 | 含义 |
| --- | --- |
| `*` | 匹配单层层次中的任意数量非 `/` 字符 |
| `?` | 匹配单层层次中的一个非 `/` 字符 |
| `[0]`、`[!A]` | 单字符类 |
| `**` | 跨零个或多个层次段匹配 |
| `\\ `、`\\[`、`\\*` | 分别匹配字面空格、`[`、`*` |

示例：

- `U_CORE/U_FSM/state[0]` 是通配单字符类，匹配 `state0`。
- `DIN\\[\\*\\]` 匹配字面端口名 `DIN[*]`。
- `U_IP/U\\ SPACE/pin/a` 匹配实例名中包含空格的 pin。

匹配诊断分三类：

- `EMPTY_MATCH`：无对象命中，错误。
- `SINGLE_MATCH`：含通配符但最终只命中一个对象，信息提示。
- `BROAD_MATCH`：通配符命中多个对象，警告。

行尾可写 `# @expect N`。实际数量不等于 `N` 时产生 `EXPECTED_MATCH_COUNT_MISMATCH`，即使模式本身不为空也会阻止该条约束生效。

## 覆盖关系

层顺序只在同一种约束类型和公开覆盖键完全相同时生效。输入层按数组顺序从低到高排列，典型顺序为：

1. baseline
2. IP module
3. project revision

覆盖键：

| 约束 | 键 |
| --- | --- |
| `create_clock` | 命令类型 + clock name |
| `create_generated_clock` | 命令类型 + generated clock name |
| I/O delay | 命令类型 + clock + max/min + 目标对象集 |
| `set_false_path` | 命令类型 + from/through/to 解析后的对象集 |
| `set_multicycle_path` | 命令类型 + setup/hold 槽位 + from/through/to 解析后的对象集 |

因此 false path 不会遮蔽 multicycle，setup 不会遮蔽 hold，input delay 也不会遮蔽 output delay。文件顺序不能把不同类约束当成同一个键。

解析或绑定错误的后层条目不覆盖旧的有效条目。被有效后层同键条目遮蔽的旧条目记录为 `RULE_SHADOWED`。

### Multicycle 关联

setup 和 hold 有独立覆盖槽位，但 endpoint 结果总是以相同 from/through/to 路径范围成对展示：

- 后层 setup 只覆盖旧 setup，不会删除同范围 hold。
- 后层 hold 只覆盖旧 hold，不会删除同范围 setup。
- 如果 setup 有效而关联 hold 因解析/绑定错误无效，会生成 `MULTICYCLE_HOLD_NOT_EFFECTIVE`。

## Generated clock 规则

generated clock 的 `-master_clock` 可以引用任意层中有效的基础或 generated clock。跨层引用不要求主时钟先出现。

未指定 `-master_clock` 时，系统使用 `-source` pin 的已知时钟目标推断源时钟：

- 找不到源时钟：`UNRESOLVED_CLOCK_SOURCE`。
- 多个不可区分时钟驱动同一 source：`AMBIGUOUS_CLOCK_SOURCE`，必须显式提供 `-master_clock`。
- 指定的主时钟不存在：`UNKNOWN_MASTER_CLOCK`。
- 派生图存在环：`CLOCK_DERIVATION_CYCLE`。

## 日期语义

行尾注解支持 UTC 日期：

```sdc
# @effective 2026-01-01
# @expires 2026-09-21
```

生效区间采用半开区间：

```text
effective <= asOf < expires
```

因此 `asOf=2026-09-20` 时 `@effective 2026-09-21` 还未生效；`asOf=2026-09-21` 时 `@expires 2026-09-21` 已经到期。日期必须是合法 ISO 日历日期，例如不会接受 `2026-02-31`。

## 可复现排序与指纹

所有对象集、诊断、endpoint trace 和 multicycle pair 在输出前都按稳定字典序排序。合并前的指纹输入包括：

- 规则版本
- case 标识
- as-of 日期
- 设计 port/cell/pin/path 索引
- 每一层的 layer id 与内容哈希
- 编辑对象的稳定哈希集合

编辑集合的迭代顺序不改变合并指纹。同一输入层、规则版本和 as-of 日期重复创建计划会返回同一个 draft plan id。

## 冻结、发布和并发

计划状态：

- `draft`：可修改对象模式或禁用过期例外，提交前可预览 endpoint 变化。
- `frozen`：保存 merged result、endpoint 和 frozen fingerprint，不再接受编辑。
- `published`：在一个 SQLite `BEGIN IMMEDIATE` 事务中写入 release 与全部 endpoint outcome。

发布失败会回滚事务，不会出现一部分 endpoint 已采用新结果、另一部分仍是旧结果的情况。

每个可编辑对象独立维护 revision：

- 模式对象：`pattern:<entryId>:<field>:<collectionIndex>`
- 例外对象：`exception:<entryId>`

客户端提交 `expectedObjectRevision`。如果它不是当前对象 revision，API 返回 `409 object_conflict`，并返回当前 revision；不会用整份计划锁掩盖对象级冲突。

## HTTP API

- `GET /api/cases`
- `POST /api/plans`：body 为 `{ "caseId": "demo", "asOf": "2026-09-21" }`
- `GET /api/plans/:id`
- `POST /api/plans/:id/preview`
- `POST /api/plans/:id/edits`
- `POST /api/plans/:id/freeze`
- `POST /api/plans/:id/publish`

禁用例外的编辑示例：

```json
{
  "type": "disable_exception",
  "targetEntryId": "project:set_false_path:8-9",
  "expectedObjectRevision": 0
}
```

修改对象模式：

```json
{
  "type": "change_pattern",
  "targetEntryId": "baseline:set_false_path:8-9",
  "field": "from",
  "collectionIndex": 0,
  "pattern": "U_CORE/U_FSM/state*",
  "expectedObjectRevision": 0
}
```

## Fixture

- `fixtures/demo`：三层约束、转义层次、空匹配、通配符单匹配、广匹配、跨层 generated clock、恰好日期边界和 multicycle setup/hold。
- `fixtures/clock-cycle`：generated clock 环、显式 master 解析和空广匹配。
- `fixtures/multicycle-pair`：后层 setup 覆盖旧 setup 但保留旧 hold。

## 测试

```bash
corepack pnpm test -- --run
corepack pnpm build
```

测试不要求商业 STA 工具；核心合并、SQLite 事务、指纹幂等和对象级冲突都在 Vitest 中验证。
