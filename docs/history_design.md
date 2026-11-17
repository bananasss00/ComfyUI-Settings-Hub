# Workflow Manager: Stage-0 findings + History/SQLite design

Дата: 2026-11-17 (Этап 0 плана `Workflow_Manager_Agent_Plan.md`).

## 0. Baseline (зафиксирован)

- HEAD: `7a5a121 v111 - THE SMART QUEUE-START UNLOAD`; рабочее дерево чистое.
- `tools/version.py --check`: OK — entry=v111, py=v111, workflows_py=v111, manifest workflows=v111.
- Baseline-тесты: `python3 tests/py_test_workflows.py` → **PASS 186 / FAIL 0**;
  `node tests/smoke_workflows.mjs` → **PASS 293 / FAIL 0** (jsdom).
- Существующий layout (v101–v111): `py/workflows_store.py` — presets/<id>.json,
  temp/<id>.json, files listing, favorites; `web/workflows.js` — панель
  Open/Presets/Files, adapter-ladder к `app.extensionManager.workflow`,
  presets-снапшоты внутри preset-файла.

## 1. ComfyUI workflow store API (feature detection)

Реальный ComfyUI в этой среде недоступен, поэтому ВСЕ новые обращения к
фронтенду идут через существующую adapter-ladder `web/workflows.js` и
**проверяются в рантайме** (`typeof fn === "function"`), как требует план §1.
Гарантированные rung'и (уже используются v101–v111):

- `app.extensionManager.workflow` (Pinia store): `openWorkflows`,
  `activeWorkflow`, `isActive(wf)`, `getWorkflowByPath(path)`,
  `createTemporary(name, graph)`, `closeWorkflow(wf, {warnIfUnsaved})`,
  `saveWorkflow(wf)`; поля объекта вкладки: `path`, `filename`, `isModified`,
  `isPersisted`, `isTemporary`, `activeState`, `content`, `originalContent`,
  `load()`.
- Команды: `Comfy.SaveWorkflow`, `Workspace.CloseWorkflow`,
  `Comfy.NewBlankWorkflow` (проверены фактическим использованием ранее).
- Нативный endpoint: `GET /userdata?dir=workflows&recurse=true&full_info=true`,
  `GET /userdata/<path>`; заголовок `comfy-user` в запросах фронтенда.

Правило сохранения плана: **никаких выдуманных command id для Save As**.
Per-tab Save As для temp-вкладок: сперва ищем сохраняемый путь через
`store.saveWorkflow(wf, {saveAs: name})`/`saveWorkflowAs`-подобные методы
**только если они реально существуют** (feature detection), затем штатную
команду Save/Save As если она есть в `command.getCommands?()`, иначе явный
отказ с объяснением («используйте штатный интерфейс ComfyUI») — уже
реализовано так в Этапе 3 (`wfStoreSaveAsCandidate()`).

Checkpoint (захват in-memory): сериализация вкладки через
`storeWorkflowStateOf()` (`activeState` → `content`/`originalContent` →
`graph.serialize` для активной вкладки). Это существующая ladder — она и
используется новым `wfCheckpointCapture()`; если состояние недоступно,
разрешён Checkpoint дискового файла с `source: "disk"`.

## 2. Атомарность штатного ComfyUI Save (отчёт, без перехвата)

MVP НЕ перехватывает штатный Save (контракт плана §5.7). Фронтенд ComfyUI
пишет userdata через бэкенд `user_manager` (`/userdata` POST), который
создаёт временный файл и делает rename-подобную подмену; поведение
известно как «write to temp, replace», но на конкретной установленной
версии НЕ проверено (нет установленного ComfyUI в среде разработки).
Фиксация риска + opt-in решение — задача владельца на целевой машине;
в коде менеджера все СОБСТВЕННЫЕ записи (Restore/Replace, экспорт,
manifests) выполняются атомарно (`tmp` + `os.replace`) с fsync, поэтому
рискованная запись может прийти только извне менеджера.

## 3. Хранилище истории: benchmark и решение

`scripts/bench_history.py` (синтетические workflow JSON ~2 МБ × 40
revision'ов из 8 несвязанных процессов в ОДНОМ общем bare repo):

| метрика | git bare (compression 9) | zlib-9 CAS |
|---|---|---|
| суммарный размер | 186 KB | 165 KB |
| checkpoint (средний) | 31 ms | 18 ms |
| чтение ревизии | 5 ms | ~0 ms |

- Размер: паритет (git в пределах ~13% от zlib-9 CAS на полностью
  независимых ревизиях; на реальных инкрементальных правках одного
  процесса delta-компрессия packfile только улучшает позицию git —
  CAS жмёт каждую ревизию независимо).
- Git даёт дополнительное: crash-safe ref update, контроль целостности
  объектов (`fsck`), точные байты, единая object DB для процессов И
  Presets — это и требует план.

**Решение: Git preferred, CAS fallback** (автоматический, тот же UX):
`py/workflows_history.py` реализует `WorkflowHistoryStore` c backend
`git` (bare repo `<user>/settings_hub/workflows_manager/history.git`,
один ref `refs/heads/history`, общий lock) и `cas` (zlib-blobs + SHA-256,
durable parent-linked manifests) — выбирается при инициализации
(есть `git` в PATH → git; иначе cas). Оба хранят точные исходные байты.

## 4. Служебный layout (per user scope)

```
<user>/settings_hub/
  workflows/                    — как раньше (presets/, temp/, files API)
  workflows_manager/            — НОВОЕ, вне обычных workflow roots:
    history.git/                — ОДИН общий bare repository (или cas/ blobs)
    catalog/                    — durable manifests (atomic JSON): processes,
                                  revisions index, file bindings, notes
    temp/                       — undo/transaction safety snapshots (TTL)
    index/                      — SQLite производный индекс (workflow_index.db)
```

- Ничего из этого не попадает в Files listing (folder `_files_hide_dirs`
  дополнен; скан индекса исключает весь `settings_hub/` namespace).
- SQLite — только производный кэш: удаляется/повреждается → rebuild из
  filesystem + manifests, пользовательские JSON не трогаются.
- Root override/favorites остаются в DEFAULT user dir (v84/v108 контракт).

## 5. SQLite schema (Этап 2)

```
meta(key TEXT PRIMARY KEY, value TEXT)          -- schema_version, profile ver
workflow_files(
  user_scope TEXT, root_key TEXT, rel_path TEXT,   -- UNIQUE(user_scope,root_key,rel_path)
  name TEXT, folder TEXT, size_bytes INT, mtime_ns INT, inode INT,
  workflow_id TEXT NULL, raw_hash TEXT, canonical_hash TEXT,
  workflow_hash TEXT, presentation_hash TEXT, extension_hash TEXT,
  structural_hash TEXT NULL, normalization_profile_version TEXT,
  extra_summary TEXT, node_count INT, node_types TEXT,
  model_refs TEXT, search_text TEXT, parse_status TEXT, parse_error TEXT,
  indexed_at INT)
```
- FTS5 `workflow_fts(search_text)` при наличии (есть в CPython ≥3.7
  сборках; fallback — LIKE по search_text).
- Канонический hash: `json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False)`.
- `workflowHash` исключает ТОЛЬКО `extra.ds.scale/offset` (viewport) и
  `extra.frontendVersion` (environment) — оба сохраняются в canonical hash;
  всё прочее (`VHS_*`, unclassified) остаётся в workflowHash.
  `presentationHash` = hash подтверждённых presentation-полей
  (`extra.ds`, nodes[].pos/size/визуальные поля по schema);
  `extensionHash` = hash unclassified/behavior-relevant extra-полей.
  Профиль версии `nprof1` в `meta`; смена правил = новая версия + reindex.

## 6. History model (Этап 2.5)

- `Process`: `{processId, workflowId, displayName, note, locations[],
  currentRevisionId, stableRevisionId, archived}` — manifest
  `catalog/processes/<processId>.json`.
- `Revision`: `{revisionId, processId, parentRevisionId, source(checkpoint|
  import|restore|disk), sourcePath, createdAt, note, rawHash, canonicalHash,
  workflowHash, presentationHash, extensionHash, nprof, storage{backend,
  blob}}` — manifest `catalog/revisions/<revisionId>.json`; bytes в общем
  store (git blob / cas blob), dedupe по rawHash.
- Checkpoint: serialize вкладки → байты → если rawHash == последний →
  дубликат не создаётся. Обычный Save: никаких ревизий.
- Restore: по умолчанию «открыть копию»; «Replace current file» — отдельное
  подтверждение + transaction safety snapshot (`temp/`, TTL) + атомарная
  запись; rollback из snapshot при сбое.
- Presets history (Этап 4): sidecar `preset_versions/<pid>/<rid>.json` в том
  же root, где preset, + endpoint-ы; при overwrite/merge/import/archive
  предыдущая версия, не в git (presets в git-namespace отдельном, поэтапно).

## 7. Version/Release

- bump: `tools/version.py vNNN` → entry/stores/README одним числом;
  `WF_WEB_VERSION` + `WORKFLOWS_SERVER_VERSION` совпадают (панель
  сравнивает с /health).
- Регресс перед финалом: py_test_workflows.py + smoke_workflows.mjs + новые
  тесты.
