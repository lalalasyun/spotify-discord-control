# Brief: spotify-oauth-cli

## One-liner

Spotify OAuth PKCE で再生状態取得と再生操作を行い、任意で Discord に再生カードと操作ボタンを出す CLI。

## Users

- Spotify の現在再生状況を自分の bot やローカル環境に連携したい人
- Discord に簡単な再生カードと操作ボタンを置きたい人
- Cookie ベースの Spotify 操作を避け、公式 Web API で運用したい人

## MVP

1. 利用者自身の Spotify Developer App で OAuth login できる
2. token はローカルに `0600` で保存する
3. `now`, `devices`, `play`, `pause`, `next`, `prev`, `transfer` が使える
4. `saved`, `like`, `unlike`, `toggle-like` が使える
5. local API と SSE で再生状態を同期できる
6. Discord bot が再生カードを投稿し、ボタン操作を CLI に接続する

## Non-goals

- Spotify API key や Discord bot token の配布
- hosting の固定
- playlist 管理や検索 UI
- 特定の個人環境に依存する helper

## Security

- `.env`, token files, Discord bot token は git に入れない
- OAuth access token / refresh token は標準出力に出さない
- Doppler には app credentials を置けるが、OAuth token 本体はローカル保存を基本にする
