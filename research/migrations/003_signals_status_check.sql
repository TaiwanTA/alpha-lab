-- 003_signals_status_check.sql
-- Status 流轉保護:只允許 5 個合法值
-- 對應:B agent 建立 discovered → C agent 改 tracking → D 報告後改 matured → 過時改 faded/invalid

ALTER TABLE signals
  DROP CONSTRAINT IF EXISTS signals_status_check;
ALTER TABLE signals
  ADD CONSTRAINT signals_status_check
    CHECK (status IN ('discovered', 'tracking', 'matured', 'faded', 'invalid'));