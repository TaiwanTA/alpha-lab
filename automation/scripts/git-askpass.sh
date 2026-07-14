#!/usr/bin/env bash
#
# git 在設了 GIT_ASKPASS 且遠端要認證時,會 fork 這個 script
# 並把要問的問題當作第一個參數傳進來 (例如
# "Username for 'https://github.com'" 或
# "Password for 'https://x-access-token@github.com'")。
#
# 依 prompt 字串分流:
#   - Username prompt  -> 輸出字面值 "x-access-token"
#     (跟 URL 裡已經放好的 username 一致;這樣 git 會
#      繼續問 password,不會卡在 username 階段)
#   - Password prompt  -> 從 $GIT_READ_TOKEN 輸出 token,
#     加上換行 (git askpass 協定一次讀一行;換行是慣例
#     的行結束符)
#   - 其他             -> 同 Password 的 fallback
#     (防舊版 git / go-git 重試路徑出現其他 prompt)
#
# Token 從呼叫端的 process env 讀進來 (dagu step env,由
# systemd unit 的 EnvironmentFile /etc/alpha-lab/dagu.env 設定)。
# 這個 script 自己讀變數,但除了最後的 printf (git 透過 fd 1
# 收走以滿足認證 prompt) 之外不會 log 或 echo。
#
# 檔案權限:mode 0750、owner root:alpha-lab-dagu。alpha-lab-dagu
# 需要讀+執行 (git 用呼叫端 user 跑 askpass,呼叫端就是
# alpha-lab-dagu)。token 對其他 user 不可讀。
#
# 為什麼要這個:之前的做法把 token 嵌在 git URL
# (`https://x-access-token:${TOKEN}@github.com/...`),這會
# 讓 token 漏到 ps、dagu log 跟 shell history。用 askpass
# 之後 URL 只放 username `x-access-token`,密碼走 git 的
# credential channel,不會出現在 argv。
set -euo pipefail
: "${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in the dagu step env}"
case "${1:-}" in
  Username*) printf 'x-access-token\n' ;;
  *)         printf '%s\n' "${GIT_READ_TOKEN}" ;;
esac
