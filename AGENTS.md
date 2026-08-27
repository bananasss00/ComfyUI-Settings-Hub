# AGENTS.md — гайд для ИИ-агентов над `ComfyUI-Settings-Hub`

Прочитай этот файл перед любыми правками. Он описывает архитектуру,
инварианты, которые нельзя ломать, рабочий процесс тестирования и упаковки.

---

## 1. Что это за проект

Frontend-ориентированное расширение ComfyUI: узел **SettingsHub** («пульт»)
принимает на себя виджеты других нод через пиннинг (ПКМ → 📌 Pin) и
зеркалит их значения с двусторонней синхронизацией в реальном времени —
без проводов и вспомогательных нод. Поддерживает вкладки, пресеты,
DnD-сортировку, «живые порталы» кастомных DOM/canvas-панелей сторонних нод
(rgthree и т.п.) и комбо с живым поиском.

Python-часть — заглушка (`py/settings_hub.py`), вся логика живёт в `web/`
(ES-модули, грузятся через `WEB_DIRECTORY = "./web"`).

## 2. Карта файлов

```text
__init__.py            — регистрация ноды "SettingsHub" + WEB_DIRECTORY
py/settings_hub.py     — Python-заглушка (FUNCTION = "noop"), логики НЕТ
web/settings_hub.js    — точка входа: app.registerExtension, загрузка CSS
web/core.js            — конфиг хаба, detectWidgetType (самолечение типов),
                         createBinding, liveComboValues, comboTokensMatch-контракт
web/sync.js            — шина структурных/values-обновлений + shared edit-lock
                         (beginEdit/endEdit), rAF-очередь queueHubRefresh
web/sync_manager.js    — хуки реактивности на целевых виджетах (обёртка callback),
                         writeTargetValue под lock'ом, self-healing вызовы
web/hub_ui_renderer.js — весь UI хаба: табы, строки зеркал, searchable combo
                         popup, layout-движок (AUTO/FILL), события (делегирование)
web/hub_node.js        — класс узла: onResize (user vs auto sizing),
                         бейдж 📌 через обёртку LGraphCanvas.drawNode
web/context_menu.js    — пиннинг: ПКМ по hover-виджету; пункт меню ноды
                         "Pin custom panel"; перехват Ctrl/Cmd+ПКМ (capture)
web/portal_manager.js  — живые встраивания: DOM-relocation, canvas-порталы,
                         групповые whole-panel embeds, геометрия/тикер
web/preset_manager.js  — снапшоты ВСЕХ widget_binding хаба (порталы исключены)
web/dnd_manager.js     — HTML5 DnD: reorder строк, drop на вкладку = перенос
web/pins.js            — кэш счётчиков пинов для бейджа 📌
web/styles.css         — все стили (тёмная тема); классы *.hub-*
dev_plan.md            — исходный технический спек проекта
```

## 3. Архитектура и ключевые контракты

### Синхронизация (реактивная, БЕЗ опроса)
- Любой поток значений: `writeTargetValue(tn, tw, v)` → обёртка callback цели →
  values-шина → `refreshValuesDom` (rAF-коалисинг). Поллинг запрещён по дизайну.
- Каждая запись значения — строго внутри `beginEdit()/endEdit()` (shared lock
  подавляет эхо-обновления). Новые пути записи обязаны соблюдать это.

### Классификация виджетов
- `detectWidgetType(w)` — единственный источник истины: combo / checkbox /
  int / slider / text / portal. Конфиг может быть старым — `renderHub`
  самолечит типы по живому виджету (`widget_binding ↔ widget_portal`).
- НЕ примитивный value или null с кастомным DOM ⇒ `"portal"` (без хардкода
  под конкретные ноды; type:"button" исключён как helper).

### Порталы (живые встраивания)
- Перед ЛЮБЫМ `innerHTML` рендера: `Portals.releaseAll(node)` — иначе
  перенесённые элементы будут уничтожены.
- Canvas-вариант, геометрия «как у источника» (иначе клики уезжают мимо):
  * ширина = натуральная ширина ноды-источника (не сжимать в строку хаба!);
    узкая строка масштабирует канву CSS (`max-width:100%` + `height:auto`),
    `localPos()` компенсирует масштаб указателя обратно в логику;
  * строки стекаются по `widget.last_y` источника ТОЛЬКО если офсеты
    sane (строго возрастают, шаг >= нативной высоты строки; протухшие/
    нулевые last_y некоторых фронтендов схлопывали embed в одну строку —
    rgthree-кейс) — иначе фолбэк: заявленные высоты + PORTAL_ROW_GAP=4;
    высота ВСЕГДА >= суммы нативных строк (жёсткий пол),
  * `style.height` НЕ пинится (только буфер + `style.width`) — иначе
    пропорции ломаются при даунскейле.
- Высота: стек строк; панели, рисующие всё тело ноды (foreground-фолбэк или
  legacy-виджет с клипом по нижней кромке — TrixNodes-класс), дорастают до
  `size[1] - NODE_TITLE_HEIGHT` (детекция: пиксели на последней строке
  битмапа). Тикер ~12fps + `runPortalTicks(node)` в тестах. Групповые
  embeds: один canvas на всю панель, members[] в item, мышь маршрутизируется
  по ТЕМ ЖЕ tops, что и отрисовка (единый `computeLayout`).

### Layout (AUTO/FILL)
- Замер ПО ЧАСТЯМ: tab-bar + `.hub-container-inner` (+padding вьюпорта) +
  preset-row. Никогда не мерьте высоту всего root.
- AUTO: нода «обнимает» контент; FILL (`node.__hubUserH`, ставится ТОЛЬКО из
  `hub_node.onResize` при пользовательском drag, не при своём setSize):
  wrap пинится px к телу ноды, рост контента поднимает конверт по дельте.
- ResizeObserver за `.hub-container-inner`; после innerHTML — re-observe;
  точечные обновления — `notifyHubContentChanged(node)` / `relayoutHub(node)`.

### Searchable combo
- Зеркало комбо — кнопка-триггер; клик открывает `.hub-combo-pop` на
  `document.body` (fixed, не режется скроллом хаба).
- Контракт фильтра `comboTokensMatch(text, query)`: запрос режется по пробелам,
  ВСЕ токены должны найтись как case-insensitive подстроки ("lor 1.2" →
  myLora_v1.2). Пустой/пробельный запрос матчит всё.
- Значения читаются живьём при каждом открытии; запись выбора — только через
  `pushControlToTarget` (sync-lock), затем мгновенное обновление label.

### Пиннинг и меню
- Три пути: (1) ПКМ по hover-виджету — `getWidgetOnPos`; (2) пункт меню ноды
  со детерминированным списком portal-виджетов (+ "whole panel" первым для
  >=2 частей); (3) Ctrl/Cmd+ПКМ — capture-override раньше родных меню панелей.
- Shift+ПКМ везде — эскейп-хатч к браузерному/native меню. Не ломать.
- Поверхности хаба (`.hub-menu`, `.settings-hub-wrap`, `.hub-portal-host`)
  никогда не перехватываются.

## 4. Инварианты — НЕ ЛОМАТЬ

1. Никакого поллинга значений (setInterval на чтение виджетов запрещён).
2. Любая запись значения — под shared edit-lock.
3. `releaseAll` ДО каждого innerHTML перестроения UI.
4. Опции комбо читать только через `liveComboValues` (живой источник,
   фолбэк на снапшот item.options.values).
5. CSS подключается `<link>` от `import.meta.url` (работает при любом имени
   папки расширения). Inline `<style>` в DOM-виджете не использовать.
6. Схема конфига обратно совместима: старые конфиги лечатся self-heal,
   а не миграциями с потерей данных.
7. Меню / попапы живут на document.body c position:fixed (клиппинг
   скролл-вьюпортом хаба недопустим).
8. JS-строки HTML экранировать `esc()` — значения виджетов произвольные.

## 5. Тесты

Харнес: Node ESM + jsdom (`scripts/smoke_hub.mjs` ВНЕ репозитория), стабы
app.js/LiteGraph, копия реальных `web/*.js` в песочницу. Фазы A–U покрывают
детекцию типов, зеркала, write-through, пресеты, табы, DnD, multiline,
layout, порталы, whole-panel группы, пиннинг, searchable combo, аутентичную
геометрию/клики порталов (масштаб-компенсация, last_y-стек с гвардом,
клип-рост, анти-схлопывание).

```bash
node scripts/smoke_hub.mjs   # базовая линия: >=240 зелёных, 0 упавших
```

Подводные камни харнеса:
- Стаб высот висит на `Element.prototype.scrollHeight` и переживает
  innerHTML; переменная `innerContentH` протухает между фазами — сбрасывай
  в baseline 100 перед AUTO-фазами.
- После структурных изменений давай `await sleep(40)` (flush одного rAF).
- События вкладок — click по `[data-action="switch-tab"]`; у LiteGraph-like
  колбэков цель дергается вручную (`tw.callback(v)`), затем flush.

Правило: любое изменение зеркальных фич сопровождается регресс-проверкой в
подходящей фазе (или новой фазой по букве).

## 6. Упаковка и коммиты

```bash
# артефакт для установки в ComfyUI/custom_nodes (без .git/__pycache__)
zip -rq ComfyUI-Settings-Hub.zip ComfyUI-Settings-Hub \
    -x "*/.git/*" -x "*__pycache__*" -x "*.pyc"
```

Коммиты — Conventional Commits (`feat(scope): ...`, `fix(ui): ...`,
`docs: ...`). Стоящее правило проекта: КАЖДОМУ фиксу/фиче — название
коммита в ответе пользователю, включая ретроспективные.

Отладка в реальном ComfyUI: F12 → Console (ошибки модулей всплывают при
загрузке страницы), либо жёсткое обновление фронта (Ctrl+F5) после замены
файлов `web/`.
