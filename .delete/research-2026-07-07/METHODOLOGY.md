# METHODOLOGY — 我們怎麼研究

> 這份文件是「研究方法論」 — 我們怎麼挑選來源、評估可信度、做信心校準,以及反思我們的研究流程本身。
> 隨著經驗累積,這份文件本身也要更新。
> 標籤: [[SCHEMA]] [[reflection]] [[calibration]] [[methodology]]

## 1. 為什麼需要方法論

研究知名投資人,聽起來簡單 — 讀讀新聞、抄抄論點。
但**真正的研究是什麼?是區分「某人說了什麼」與「那件事為什麼重要」**。

我們的方法論要回答:
- 來源的可信度怎麼排序?
- 我什麼時候該相信一個論點?
- 我怎麼知道自己現在的理解是「真的」還是「我以為的」?

## 2. 來源優先級 (從高到低)

### Tier A — 投資人本人第一手發言
- **價值最高**:股東信、自傳、訪談的逐字稿
- **特點**:可看到他的 reasoning 過程,而不只是結論
- **處理**:標記日期 + 上下文(他在對誰說、為什麼說)
- **範例**:Berkshire 2024 股東信、Howard Marks memo、Charlie Munger Poor Charlie's Almanack

### Tier B — 第一手 + 公開聲明
- **價值次高**:X (Twitter) 發文、podcast 訪談、CNBC 公開訪談
- **特點**:有時序、即時,但可能被截圖扭曲、需對照上下文
- **處理**:**務必保留原 tweet URL + 截圖時間**,避免「3 個月後引用已被刪除的 tweet」的情境
- **範例**:Bill Ackman @BillAckman tweet、Burry @michaeljburry tweet、Marc Andreessen 訪談 podcast

### Tier C — 公開揭露文件
- **價值高(被動型信號)**:13F (持倉)、13D/13G (5%+ 大股東)、Form 4 (insider)、公司年報
- **特點**:硬數據、不容易被操弄,但延遲 45 天
- **處理**:每次揭露都記錄,並與前一季比對變化
- **範例**:BRK 13F 2024Q3、Pershing Square 13F

### Tier D — 第三方深度分析
- **價值中等**:高水準的財經記者深度報導、Substack 優質研究、學術論文
- **特點**:可能有觀點偏差,但好的分析師 (e.g. Tren Griffin, John Hempton) 是我們的「二手延伸思考」
- **處理**:用 Tier A/B 交叉驗證後,才寫進 wiki
- **範例**:Bloomberg 深度報導、Acquired podcast、Wealthtrack

### Tier E — 一般新聞 / 社媒討論
- **價值低(主要當 trigger)**:Yahoo Finance、Reddit r/wallstreetbets、Twitter 一般討論
- **特點**:噪音多,但偶爾有「值得深挖的 trigger」
- **處理**:當 trigger,不是 source

## 3. 信心校準框架

> 來自 Philip Tetlock 的「Superforecasting」核心原則。

### 我們對每個論點要標記信心度
- **high (80%+)**:多個 Tier A/B 來源一致,或一級數據(13F)直接支持
- **medium (50-80%)**:一兩個 Tier B 來源支持,但有矛盾的可能性
- **low (<50%)**:猜測、推論、或單一 Tier E 來源

### 每個信心度預測都要 log
- 寫在 `portfolio/decisions/<YYYY-MM-DD>-<topic>.md`
- 格式:
  ```
  ## Claim
  [具體論點]

  ## Confidence
  high | medium | low

  ## Reasoning
  [為什麼這樣評估信心]

  ## Evidence
  - raw/articles/foo.md (Tier A)
  - raw/posts/bar.md (Tier B)
  ```
- 三個月後驗證實際結果 → 更新 Brier score

### 校準指標
- **Brier score**: 低 = 校準好
- 每季檢視:我們的「high」預測命中率高嗎?如果 <70%,要重新校準。
- 詳見 `portfolio/decisions/calibration-log.md`

## 4. 寫入 wiki 的標準

### 引用規則
- 直接引用原文 → 加引號 + `^[raw/articles/foo.md]` 標記
- 轉述(paraphrase) → 加 「據 X 在 Y 表示,大意為...」
- 不要**為了順暢而抹平矛盾** — 矛盾本身就是資訊

### 每個 entity 頁面的必備結構
1. **基本資料**:出生年、主要機構、AUM、風格標籤
2. **核心投資哲學**(1-2 段)
3. **時間軸**:重大投資決策 + 公開聲明(年份 + 月份)
4. **代表性持倉 / 著名交易**:附結果(事後驗證)
5. **核心引用** (3-5 條原文)
6. **批判與限制**:他在哪些情境下失誤?他的弱點是什麼?
7. **交叉引用**:連結到相關 entity / concept / comparison
8. **來源清單**:所有 raw/ 引用

### 每個 concept 頁面的必備結構
1. **定義**(對應哪個投資人/流派)
2. **邏輯**:為什麼這樣想?
3. **支持證據 + 反對證據**
4. **現況**(隨時間更新)
5. **相關 entity / concept**

## 5. 反思規則 — 我們的 anti-bias checklist

每次完成一份研究報告,**強迫自己回答這些問題**:
1. 我是不是在**崇拜情緒**下,過度引用了某人?
2. 我是不是過度解讀了一個 tweet(把它當成宏大論點)?
3. 我有沒有引用任何**他沒說過的話**?
4. 我有沒有忽略他的**失敗案例**?
5. 換一個相反立場的投資人(e.g. 抄底的 vs 做空的),他們會怎麼批評這個 entity?
6. 我的信心度是基於證據,還是基於「這個投資人說的話多就被信服」?

每個反思答案都寫到 `reflection/<YYYY-MM>-<topic>.md`。

## 6. 工具 vs 內容

工具(xurl、blogwatcher、LLM Wiki)是**輔助**,不是目的。
- 不要為了「發了 10 篇 tweet 摘要」這種 KPI 而研究
- 真正有價值的是:**一篇 entity 頁面 + 一個 concept 頁面 + 一次反思**

數量 vs 深度的取捨,我們選深度。

## 7. 我們不做的事

- ❌ 不做 day-trading 追蹤 — 那是 trader 的工作,不是 investor 的工作
- ❌ 不做價格預測 — 我們追蹤**判斷邏輯**,不是方向
- ❌ 不做「神化/醜化」 — wiki 是中性工具,崇拜與詆毀都會扭曲判斷
- ❌ 不做「現在該不該買」的建議 — 我們追蹤的對象是「知名投資人」,不是「對用戶的投資建議」
- ❌ 不抄別人的 wiki — 我們要有自己的 cross-reference 與反思

## 8. 我們做的特殊事

### ✅ 模擬投資組合(`portfolio/`)
- 我們根據某投資人的具體公開觀點,**模擬下注**
- 詳見 [[PORTFOLIO-FRAMEWORK]]

### ✅ 跨投資人觀點衝突分析(`comparisons/`)
- 同樣事件,兩個投資人看法不同 → 寫成 comparison 頁面
- 這比單獨研究更接近真實市場

### ✅ 公開對我們的研究本身做反思(`reflection/`)
- 我們會犯錯 — 會過度解讀、會追逐噪音、會偏離方法論
- 把這些犯錯寫下來,比「寫對一篇報告」更有長期價值

## 9. 待持續完善的問題

- [ ] 我們的「信心度」有沒有可能太依賴來源數量,而非來源品質?
- [ ] 中文圈投資人的 source quality 要怎麼評估?(段永平網易博客 vs 但斌微博)
- [ ] 我們怎麼處理**刪除的 tweet**?(xurl 是否能 cache 內容)
- [ ] 我們怎麼處理**虛假帳號**(仿冒帳號在 X 很常見)?

這些問題的答案會隨研究經驗累積而浮現。