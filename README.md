# Siberflow

AI platform with multi-provider support and tool calling. Currently supports the CLI interface with the DeepSeek provider; web and VSCode extension are planned.

## Structure

This is an npm workspaces monorepo.

- `packages/core` — provider-agnostic agent loop, provider adapters, tool registry, and built-in tools (file management & CLI exec)
- `packages/cli` — interactive terminal interface

## Quick start

```bash
npm install
cp .env.example .env
# edit .env and add your DEEPSEEK_API_KEY

npm run dev:cli
```

## Developer docs

Untuk arsitektur, alur eksekusi, cara menambah provider/tool/interface, roadmap, dan catatan desain — baca [DEVELOPMENT.md](DEVELOPMENT.md).
