# figma-mcp-bridge

Локальный мост между Claude Code и Figma Desktop. Агент может не только читать макет, но и **писать в него**: создавать фреймы, текст и векторы, двигать и удалять слои, менять контуры, экспортировать в PNG и SVG.

```
Claude Code ⇄ server/index.js (MCP, stdio) ⇄ server/bridge.js (WebSocket, localhost:3055) ⇄ плагин внутри Figma Desktop
```

Работает через **Plugin API** Figma. Всё крутится на твоём компьютере, наружу ничего не уходит.

> Это независимый проект, не продукт Figma. Плагин запускается как development-плагин из манифеста. Следи за условиями Figma и своим тарифом.

## Установка (один раз)

Нужны Node.js 20+, Figma Desktop и Claude Code.

1. Клонировать репозиторий и поставить зависимости:
   ```
   git clone https://github.com/tw1st3rrr/figma-mcp-bridge.git
   cd figma-mcp-bridge
   npm install
   ```
2. Подключить MCP-сервер к Claude Code (путь подставь свой):
   ```
   claude mcp add --scope user figma -- node <полный путь>/figma-mcp-bridge/server/index.js
   ```
3. В Figma Desktop: **Plugins → Development → Import plugin from manifest…** и выбрать `plugin/manifest.json`.

## Каждый раз

1. Открыть файл в Figma Desktop.
2. **Plugins → Development → Figma MCP Bridge**. Окно плагина держать открытым, в нём должно быть `connected`.
3. В Claude Code вызвать `figma_status`: должно вернуть `pluginConnected: true`.

Порт по умолчанию 3055, меняется переменной `FIGMA_BRIDGE_PORT` (и в окошке плагина).

## Инструменты

| Группа | Инструменты |
| --- | --- |
| Состояние | `figma_status`, `figma_get_document`, `figma_get_selection`, `figma_get_node`, `figma_get_page_tree`, `figma_find_nodes` |
| Правка | `figma_set_props`, `figma_translate`, `figma_delete`, `figma_group`, `figma_ungroup`, `figma_set_page`, `figma_select`, `figma_notify` |
| Создание | `figma_create_rectangle`, `figma_create_frame`, `figma_create_text`, `figma_create_vector`, `figma_import_svg` |
| Векторы | `figma_get_vector_paths`, `figma_set_vector_paths`, `figma_boolean`, `figma_flatten` |
| Экспорт | `figma_export` (PNG, JPG, SVG, PDF) |
| Запасной путь | `figma_run_js`: произвольный async-JS в песочнице плагина |
| REST (только чтение, нужен `FIGMA_TOKEN`) | `figma_rest_file`, `figma_rest_images` |

## Честные ограничения

- Нужен запущенный Figma Desktop с открытым плагином. Без него мост ничего не сделает.
- `figma_run_js` выполняет произвольный код в плагине: давай его только агенту, которому доверяешь.
- Токен для REST (`FIGMA_TOKEN`) читается из окружения и никуда не пишется.

## Лицензия

MIT, см. `LICENSE`.
