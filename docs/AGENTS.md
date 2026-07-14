# AGENTS.md — docs/ 目錄

## 這裡做什麼

`docs/` 放的是 workspace-root 層的跨切面文件 — 跨 `research/` 跟 `blog/` 兩個子元件的決策跟規格。

不放在 `research/docs/`(之前的位置):兩個子元件平起平坐,跨切面的事不該塞進其中一個。

## 檔案分類

- **ADR**(`ADR-NNN-<topic>.md`)— 重大架構決策的歷史。一份 ADR 解釋「為什麼現在這樣做」,spec 解釋「現在怎麼做」。
- **specs/**(`specs/<file>.md`)— v2 規格。sub-component 從 `docs/specs/AGENTS.md` 開始讀。

## 命名

- kebab-case(`ADR-002-v2-dagu-pivot.md`、`signal-discovery.md`)
- **不加日期**:α-lab 不會有多份並存的 v2 spec,日期是噪音
- **不寫 owner 後綴**:不要 `JOKER-spec.md`
- ADR 編號連續從 `001` 往上;新加的要 skip 已被刪掉的編號(沿用歷史)

## 修改原則(這最重要)

- **spec-first**:改實作之前先改對應 spec(spec 是 source of truth)
- **同 PR**:spec 跟實作的改動放同一個 commit / PR,確保 spec 跟 code 同步
- **DRIFT-GUARD 是這裡最強的規則**:跨切面 rule 不能散落到各 feature spec,任何該引用的地方都要 cross-reference 回來
- 改 `cross-cutting.md` 是高風險動作(影響多個 feature spec),需要 review

## 怎麼加一份 ADR

1. 命名 `ADR-NNN-<topic>.md` 找下一個可用的編號
2. 引用所有相關 commit hash(讓 audit 容易追溯)
3. 涵蓋:Context / 考慮過的方案 / 決定 / 後果(含不好的一面)/ 後續決策點
4. **不要取代已有 ADR**:如果新決策推翻舊的,在舊的加 SUPERSEDED banner 指向新的,或新寫一份 ADR-XXX 標明 supersedes,而不是把舊的刪掉(刪掉的歷史還在 git log)

(注:α-lab v2 破例把 ADR-001 git 刪了,因為內容已完全失效且 git history 完整保留。)

## 怎麼加一份 spec

讀 [`specs/AGENTS.md`](specs/AGENTS.md)的 spec 骨架說明,不要憑感覺。

## 跟其他 AGENTS.md 的關係

- 上:`[`/AGENTS.md`](../AGENTS.md) — workspace 整體(環境、路徑、進度)
- 同層:`[`/research/AGENTS.md`](../research/AGENTS.md)跟 `[`/blog/AGENTS.md`](../blog/AGENTS.md) — 子元件指南
- 這份 — `docs/` 自己的指引
- 下:`[`/docs/specs/AGENTS.md`](specs/AGENTS.md) — specs 子目錄自己的指引

閱讀順序:先根 `AGENTS.md`,再這份,再進 `specs/AGENTS.md`。

## 不做的事

- 不寫 README.md(這個目錄用 AGENTS.md)
- 不放自動產生的文件(例如 type spec、api doc — 那些給 build pipeline)
- 不放單獨子元件的 deep dive(那是 research/ 或 blog/ 內的事)
- 不寫 archived 版本的副本(spec 演進在 git log 找得到,不需要保留 dead copy)
