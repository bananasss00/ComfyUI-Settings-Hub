# AGENTS.md — гайд для ИИ-агентов над `ComfyUI-Settings-Hub`

Прочитай этот файл перед любыми правками. Он описывает архитектуру,
инварианты, которые нельзя ломать, рабочий процесс тестирования и упаковки.

---

## 1. Что это за проект

Frontend-ориентированное расширение ComfyUI: узел **SettingsHub** («пульт»)
принимает на себя виджеты других нод через пиннинг (ПКМ → 📌 Pin) и
зеркалит их значения с двусторонней синхронизацией в реальном времени —
без проводов и вспомогательных нод. Поддерживает вкладки, пресеты,
DnD-сортировку, пиннинг КНОПОК нод (rgthree Seed «Randomize Each Time» и
т.п.), встроенный ▶ Queue ×N (очередь ComfyUI прямо из хаба), «живые
порталы» кастомных DOM/canvas-панелей сторонних нод (rgthree и т.п.) и
комбо с живым поиском.

Python-часть — заглушка (`py/settings_hub.py`), вся логика живёт в `web/`
(ES-модули, грузятся через `WEB_DIRECTORY = "./web"`). Инвариант стаба:
БЕЗ `OUTPUT_NODE` и `noop()` возвращает `()` — иначе executor запускает
узел при каждом queue, а `merge_result_data` падает
`TypeError: 'NoneType' has no len()` (реальный инцидент v1).

## 2. Карта файлов

```text
__init__.py            — регистрация ноды "SettingsHub" + WEB_DIRECTORY
py/settings_hub.py     — Python-заглушка (FUNCTION = "noop", возвращает
                         (); БЕЗ OUTPUT_NODE — узел не исполняется на queue),
                         логики НЕТ
web/settings_hub.js    — точка входа-ЗАГРУЗЧИК (v35): баннер ПЕРВЫМ
                         (доказательство свежести entry в F12), затем
                         top-level await import каждого модуля с try/catch
                         — сбой называет ТОЧНЫЙ файл (тихая смерть графа
                         импортов больше невозможна); JS-импорты БЕЗ query
                         (иначе дубли инстансов модулей), styles.css с ?v=;
                         частичная загрузка = hooks не регистрируются
web/core.js            — конфиг хаба, detectWidgetType (самолечение типов;
                         type:"button" без DOM-контейнера => "button"),
                         createBinding, liveComboValues, comboTokensMatch-контракт;
                         кросс-графовый поиск: allGraphs / findNodeByIdEverywhere /
                         resolveBindingTarget (id + title-drift repair) /
                         findHolderChainOf (цепочка SubgraphNode-владельцев);
                         synthSliderWindow (первичный центр) /
                         growSynthWindow (липкий односторонний рост окна);
                         числовые: numericMerge (+ sliderStep-релаксация интегральных
                         шагов не-int источников), effectiveSliderParams;
                         override-модель слайдеров: get/setSliderOverride /
                         hasSliderOverride / applyOverrideToTargetWidgets /
                         clearSliderOverride (рестор native-опций) /
                         maybeReapplySliderOverride (одноразовый session-latch);
                         createNewHub — канонический LiteGraph.createNode -> graph.add;
                         v35: createBindingsBulk (N items, ОДИН syncNode),
                         getter-гарды в findWidgetOnNode/sameNameOrdinal,
                         nodeListOf экспортирован;
                         v37: liveGraphs (только живое дерево, БЕЗ реестров
                         дефиниций) + isNodeInLiveTree (решения о живости),
                         reportUnresolved ждёт заселения графа (diagAttempts);
                         v39: mediaLoaderInfo квалифицирует mediaish-combo
                         по инстанс-хуку onDropFile (TrixLoader AIO: без
                         upload-флагов/кнопки/composables/pasteFiles);
                         v40: createNodeUIBinding - node-level биндинг в
                         viewer-форме (VIEWER_SENTINEL + options.viewer +
                         options.controls) для канвас-виджетлесс нод
                         v41: getHubConfig нормализует cfg.pinAutoHide -
                         per-hub режим автосворачивания запиненного окна
web/sync.js            — шина структурных/values-обновлений + shared edit-lock
                         (beginEdit/endEdit), rAF-очередь queueHubRefresh
web/sync_manager.js    — хуки реактивности на целевых виджетах (обёртка callback),
                         writeTargetValue под lock'ом, invokeTargetButton;
                         v37: syncAll forget+dispose мёртвых хабов ДО
                         syncNode (воскрешение пин-окон закрыто)
                         (запуск запиненной кнопки на ЖИВОЙ ноде,
                         никогда не трогает .value), self-healing вызовы
web/hub_ui_renderer.js — весь UI хаба: табы, строки зеркал, searchable combo
                         popup, gear-поповер кастомных min/max/step (.hub-num-pop,
                         Apply/Push/Clear + checkbox auto-apply), layout-движок
                         (AUTO/FILL), события (делегирование; wheel-слайдеры);
                         pruneForeignHubs — санитария реестра и плавающих окон
                         после graph configure (воркфлоу-переключение);
                         v35/v36: installHubTabWatch — вотчер смены
                         workflow-вкладок (v36: свип по СИГНАТУРЕ
                         содержимого корней — ловит in-place свопы без
                         смены identity; пустое-но-читаемое множество =
                         реальный свитч, нечитаемое/ненаблюдавшееся =
                         observe-only, чужой пин -> homeHub с выжившим
                         cfg.pinned, 5 сбоев = самоотключение);
                         v38: paste из буфера (Ctrl+V) в media-строки —
                         hover-arm строки + document-CAPTURE перехват
                         РАНЬШЕ usePaste фронта (иначе тот ставит НОВУЮ
                         LoadImage): pasteFiles ноды → pasteFile →
                         uploadMediaFiles; гарды editable/Shift/файлы,
                         kind-матч, kind-фоллтринч по строкам хаба;
                         v39: uploadMediaFiles Route A2 - нативный
                         onDropFile-хук пака (TrixLoader AIO), decline/
                         throw -> /upload/image; paintMediaPreview
                         предпочитает input-спеку стора и парсит
                         subfoldered combo-значения для /view
                         v41: авто-сворачивание пин-окна: applyPinMin -
                         ЕДИНАЯ точка collapse/expand (кнопка «–» и
                         движок), движок auto-hide (leave -> fold c
                         grace-задержкой и отменой по re-enter; hover
                         заголовка свернутого -> expand c intent-
                         задержкой), гварды драга/ресайза (endDrag/
                         endRsz -> autoHideCheck) и body-попапов
                         (.hub-menu/.hub-batch/.hub-toast/
                         .hub-fs-overlay), кнопка ⇲ в шапке пин-панели
web/hub_node.js        — класс узла: onResize (user vs auto sizing),
                         бейдж 📌 через обёртку LGraphCanvas.drawNode;
                         afterConfigureGraph первым делом зовёт
                         pruneForeignHubs (до syncAll выживших);
                         setup() ставит installHubTabWatch (v35/v36)
web/context_menu.js    — пиннинг: ПКМ по hover-виджету; пункт меню ноды
                         "Pin custom panel"; "🖼 Pin viewer" (v26); фильтр
                         служебных "$$"-виджетов фронтенда (v26.1); перехват Ctrl/Cmd+ПКМ (capture);
                         v35: "📦 Add widgets to hub (batch)…" первым пунктом
                         меню ноды + пикер (чекбоксы, чипы типов,
                         select all/none, цели хаб/вкладка/New Tab/Create Hub,
                         Add N disabled при нуле); цели = allHubs() (как у
                         всех меню, без activeHubs-гейтинга v34);
                         v40: «🎛 Pin node UI (live embed)» для
                         канвас-виджетлесс нод (Pixaroma Switch-паттерн),
                         isNodeUIPinCandidate: НЕ media/viewer + onDraw
                        Foreground + listBatchWidgets пуст; подменю
                         node-embed'ов (viewer/node-UI) на общем теле
web/portal_manager.js  — живые встраивания: DOM-панели — GHOST-ЗЕРКАЛА
                         (неcтруктивный клон в хабе, оригинал НИКОГДА не
                         покидает ноду; события клона → реэвент на
                         counterpart, мутации оригинала → debounce-rebuild;
                         лок на фокус/недавний ввод), canvas-порталы,
                         групповые whole-panel embeds, геометрия/тикер;
                         viewer-встраивания (v26.2): СВОЙ медиа-элемент хаба
                         — нативный <video controls> плеер / <img> / блит
                         canvas-превью; вотчер смены src; фолбэк painter
                         +node.imgs; нормализация медиа в панельных гостах;
                         v32: ghost-база МЯГКАЯ (сохраняет flex-геометрию
                         самодостаточных панелей), жёсткий detach — opt-in
                         .hub-portal-ghost-float (computed absolute/fixed);
                         ghostSplitH (высота сплит-корня) + локальный
                         ns-resize сплит-драг клона;
                         v33: сплит-корни (flex-column + свой ns/row-resize
                         грип) НЕ проходят media-нормализацию; высота
                         инлайн-IMPORTANT (setSplitHeight) против
                         !important-правил CSS зеркал; фолбэк захвата по
                         упакованной высоте клона; ResizeObserver:
                         ресайз ноды живо ведёт зеркало;
                         v40: mountNodeUIPortal - форграунд-пейнтер
                         портал для controls-биндингов (onDrawForeground
                         1:1 + форвардинг кликов в node-local координатах
                         - тогглы Switch кликабельны ИЗ хаба), монтируется
                         МИМО media/gallery роутинга
web/viewer_gallery.js  — v27 БАТЧ-ГАЛЕРЕЯ вьюверов: свой <img>-вьювер хаба,
                         кормится от выходного стора фронтенда
                         (app.nodeOutputs / app.nodePreviewImages + легаси
                         node.images / node.imgs); навигация, счётчик,
                         миниатюры, фуллскрин-оверлей (body-level,
                         Fullscreen API + ←/→/Esc/колесо); вотчер 1с;
                         findOutputImages / mountImageGallery /
                         openGalleryFullscreen / closeGalleryFullscreen;
                         firstMediaSpec(tn, wantType) - v39 опц. фильтр
                         типа стора ("input" = спека файла-источника,
                         processed-output спеки отфильтрованы)
web/preset_manager.js  — Presets 2.0 (v28) + UX (v29): v2-снапшоты АКТИВНОЙ
                         вкладки (чип item.inPreset, excluded-мета, кнопки/
                         порталы мимо), presetSave (имя из quick-save,
                         confirm на перезапись), presetMergeInto (матч
                         itemId -> stable-key -> добавление, scope/ts/excluded
                         от снапшота), buildApplyPlan/applyPlan (инспекция,
                         валидация combo, клэмп, частичное применение), undo
                         (память модуля), presetFavToggle / presetExportOne /
                         presetBulkOpt / presetPickerModel,
                         rename/duplicate/countDead/cleanDead,
                         exportAll/importFromText; stable-key fallback
                         nodeId+widget для перепинов
web/global_settings.js — ГЛОБАЛЬНЫЕ настройки хаба (v26/v27): скорость обновления
                         зеркал (localStorage "settingshub.refreshMs"), + v27: глобальные
                         видеопредпочтения settingshub.videoMuted /
                         settingshub.videoVolume (getVideoAudio /
                         setVideoAudio / applyVideoAudio)
                         опциональный catch-up поллер refreshNodeValues по
                         всем хабам; 0 = только события (дефолт)
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
  под конкретные ноды).
- Пиннинг кнопок v23: type:"button" без реального DOM-контейнера =>
  класс "button" (зеркало ▶ run); С DOM-контейнером проваливается в
  "portal" (гарантия DOM-панелей сильнее строки типа). Мертвые кнопки
  (нет callable callback) = helpers: меню их НЕ пинит (`isHelperWidget`),
  детект при этом всё равно "button".
- Правило DOM-панелей: виджет с РЕАЛЬНЫМ контейнером (`element`/`contentEl`,
  не textarea) — это `"portal"`, ДАЖЕ если value — строка (LTX/PlagueKind
  «LoRA Loader Stack»: один addDOMWidget + непрозрачный JSON). Гвардии:
  textarea остаётся multiline-зеркалом; объявленные примитивы (values,
  min/max/step, number/slider/int/float в типе) не переклассифицируются.

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
- Высота: стек строк — ПОЛ; дальше работает пиксельный settle-цикл
  (`scanCanvas` + `settleAutoHeight`, один проход getImageData за тик):
  контент касается последней строки битмапа → рост +30 (cap:
  max(формула, size[1]) + NODE_TITLE_HEIGHT + 8); низ чист → обрезка до
  последней закрашенной строки +2px. Идемпотентно на контент+2 — без
  осцилляций. БАЗА foreground-панелей — ПОЛНЫЙ `size[1]`: некоторые ноды
  кладут в size[1] высоту панели БЕЗ надбавки на титул (TrixNodes:
  `node.size[1] = neededH`), вычитание титула резало ровно один ряд
  («последний элемент никогда не помещается»). Перерост (ноды, считающие
  size[1] С титулом) подрезается тем же циклом. Тикер ~12fps +
  `runPortalTicks(node)` в тестах. Групповые embeds: один canvas на всю
  панель, members[] в item, мышь маршрутизируется по ТЕМ ЖЕ tops, что и
  отрисовка (единый `computeLayout`).

### v27.1: ghost-зеркала — ребилд не должен замереть после кликов
- Symptom (PromptChecker-токены, «некоторые другие кастомные ноды»): клик по
  кнопке внутри ghost-зеркала применялся к источнику, но зеркало обновлялось
  ТОЛЬКО после сдвига графа.
- Причина: Chromium оставляет фокус на кликнутой `<button>`; busyLocked()
  считал ЛЮБОЙ фокус внутри клона признаком «пользователь занят» → retry-цикл
  deferral держался вечно, ребилд случался только когда фокус уходил (пан
  графа = blur).
- Контракт: defer только для TEXT-ENTRY фокуса (TEXTAREA/INPUT/SELECT/
  contentEditable — isTextEntry). Завершённый `click` (capture-фаза на клоне)
  синхронно снимает TOUCH_LOCK — forward+dispatch это одна синхронная задача,
  мутоция от клика может ребилдиться на ближайшем debounce-тике (~180мс).
  Drag-события (dragstart/drag/dragend/drop/pointercancel) держат лок
  вооружённым (клик браузером подавляется, ребилд не может приземлиться
  середрагом).
- rebuild() переносит НЕ-текстовый фокус на counterpart свежего клона
  (indexPath + focus({preventScroll:true})) — клавиатурные переключатели
  продолжают работать после обновления зеркала.

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

### Числовые зеркала — верность источнику
- `numericMerge(item, tw)` — ЕДИНСТВЕННЫЙ источник min/max/step: live опции
  > снапшот item.options. Необъявленная сторона границ = ±Infinity (в разметке
  атрибут НЕ пишется, клэмпа нет) — никаких выдуманных стен [0..1].
- Step: объявленный step > round > precision-производный (10^-digits) →
  range-фолбэк (только синтетический может подстраиваться под диапазон).
  Классификация int/slider учитывает precision/round: float без step больше
  не деградирует в int.
- SLIDERSTEP-релаксация v21: `step` остаётся ВЕРНЫМ источнику, а для ДРАГА и
  программного квантования служит `sliderStep` (= step во всех случаях,
  КРОМЕ интегрального step>=1 у НЕ-int зеркала — тогда цепочка fine-фолбэков:
  дробный round > precision > range/0.01). Целый шаг PrimitiveFloat=1 больше
  не запирает ползунок на сетке 0,1,2 (полевой инцидент v21). decimals
  программного квантования считаются от sliderStep. Семейство int — нетронуто.
- Редактор зеркала — `type="text" inputmode="decimal"`: нативный type=number
  САНТИЗИРУЕТ value на сеттере ("0,9" -> "") и убивает ввод до нашей
  валидации. Полный пайплайн наш — в `coerceNumeric`: ручной ввод (change,
  manualText=true) сохраняет точные десятичные (без сетки шага, запятая =
  точка), клэмп ТОЛЬКО по реально объявленным границам; программные/стрелки
  квантуются как раньше; int по-прежнему округляет.
- `input`-событие number НЕ прокидывает значение (частичные строки "0." не
  бьют в цель); коммит только на change. refreshValuesDom НЕ перетирает
  сфокусированный контрол (эхо-гвардия; ресинк после blur/commit).
- merged min/max/step лечатся обратно в item.options (выживание орфанов).

### Slider overrides (⚙ на числовой строке)
- Модель: `item.sliderOverride = { min?, max?, step?, applySliderOverride?, native? }`
  живёт в конфиге хаба (переживает reload/presets). Присутствие поля = стена;
  отсутствие = семантика источника той стороны.
- Контракт setSliderOverride(item, patch): BARE patch {} — ПОЛНАЯ зачистка
  (API-wipe БЕЗ рестора; для восстановления используйте clearSliderOverride);
  любой явный ключ — MERGE: значение ставит стену, null/"" снимает сторону,
  опущенный ключ сохраняет прежнее. step строго >0. native-снапшот переносится
  через все rebuild'ы объекта (иначе повторный пуш записал бы кастомные числа
  как «натив»).
- НАТИВНЫЙ СНАПШОТ (v22): первый пуш (applyOverrideToTargetWidgets) ДО записи
  копирует текущие tw.options {min,max,step}+объявленные precision/round в
  sliderOverride.native. clearSliderOverride(item) = рестор нативов на живой
  виджет + удаление override-ключа; best-effort: цель не резолвится → config
  чистится, restored=false (честный отчёт). API-bare {} restore НЕ делает.
- STEP-КОГЕРЕНТНОСТЬ пуша (v22): многие фронты ведут драг по precision/round,
  а не по сырому step — потому при наличии ОБЪЯВЛЕННЫх полей:
  round := step (квант равен шагу), precision := max(orig, decimals(step)) —
  только повышаем, никогда не сужаем; отсутствующие поля НЕ изобретаем.
- Рендер — ТОЛЬКО через effectiveSliderParams(item,tw)= numericMerge ⊕ override;
  override-границы действуют как стены и для ручных коммитов (coerceNumeric
  клэмпит по объединению source∪override). Парность «статичный ↔ синтетический»
  выбирается по эффективным границам; overridden-слайдер носит класс
  .hub-range-ovr, гайка строки подсвечена (.hub-gear-on).
- Поповер — body-level fixed (.hub-num-pop); валидация полей inline
  (.hub-pop-bad), пустое поле = снять сторону; кнопки ✓apply / ⤴push / clear / ✕
  (clear идёт через clearSliderOverride — С РЕСТОРОМ). Плейсхолдеры показывают
  native со суффиксом «·node»; без снапшота — эффективные с «·src». Push пишет
  числа в ЖИВОЙ виджет немедленно; флэш-фидбек идёт на СВЕЖУЮ кнопку после
  innerHTML-свопа.

### Авто-применение override к реальным нодам
- Флаг applySliderOverride (чекбокс поповера, дефолт ON) разрешает пушь на
  целевые виджеты. После перезагрузки страницы ComfyUI пересоздаёт виджеты из
  определений — renderHub self-heal вызывает maybeReapplySliderOverride(item):
  одноразовый session-latch по item.id (тест resetOverrideAppliedTracking()),
  чтобы структурные рендеры не спамили патчи. OFF блокирует даже пост-reload путь.
- resolveBindingTarget возвращает ГОЛУЮ НОДУ (не пару {tn,tw}) — деструктурировать
  оборонительно (инцидент ZC-написания: TypeError при orphan-resolve).
- ОГРАНИЧЕНИЕ: нативы, затёртые пушами ДО введения снапшота (≤v21), невосстановимы —
  у тех биндингов Clear лишь снимет кастом (уже добавьте оригиналы руками один раз).

### Вкладки — переименование поверх перерендера
- Нативный dblclick по кнопке вкладки НЕВОЗМОЖЕН: первый клик пересобирает
  бар через innerHTML, второй физический клик попадает в заменённый элемент,
  браузерный dblclick-цепочка рвётся. Детект двойного клика — НА УРОВНЕ click:
  два клика по одной вкладке <400мс открывают inline-edit (второй клик не
  делает switch и НЕ рендерит заново, иначе swap убивает редактор).

### Пиннинг и меню
- Четыре пути: (1) ПКМ по hover-виджету — `getWidgetOnPos`; (2) пункт меню ноды
  со детерминированным списком portal-виджетов ("whole panel" первым для >=2
  частей ИЛИ одиночной addDOMWidget-панели — она без members[], через
  relocation); (3) Ctrl/Cmd+ПКМ — capture-override раньше родных меню панелей;
  (4) ПРОСТОЙ ПКМ по поверхности DOM-панели (`attachPanelSurfacePinMenu`) —
  там меню LiteGraph не бывает, открывалось сырое браузерное.
- Shift+ПКМ везде — эскейп-хатч к браузерному/native меню. Не ломать.
- Поверхности хаба (`.hub-menu`, `.settings-hub-wrap`, `.hub-portal-host`)
  никогда не перехватываются.

### Пиннинг кнопок и Queue (v23)
- Запиненная кнопка — widget_binding с widgetType:"button", options={}.
  Зеркало — `button.hub-btn-action[data-role="btn-run"]`; у него НАМЕРЕННО
  нет data-hub-control: values-шина, пресеты и echo-refresh его не касаются.
  snapshotAll/presetApply пропускают widgetType==="button" на ОБЕИХ сторонах
  (иначе DOM-фолбэк снапшота записал бы подпись кнопки как «value»).
- Клик зеркала → sync_manager.`invokeTargetButton(tn,tw)`:
  `callback.call(tw, tw.value ?? null, app.canvas, tn)` — реплика диспетча
  litegraph — ПОД begin/endEdit (обёртка хука молчит), .value НИКОГДА не
  пишется; бросок хендлера изолируется ({ok:false} + console.warn),
  UI не ломается.
- Меню: живые кнопки (callable callback) пинятся через Path 1 c меткой 🔘
  и суффиксом «· button»; мертвые (спейсеры) по-прежнему helpers.
- Самолечение: конфиги ≤v22 могли классифицировать кнопку как "portal"
  (fallback старого детектора) — существующая ветка миграции
  portal↔binding превращает её в обычный биндинг ▶ run без ghost-embed.
- Queue-бар под табами (`.hub-queue-row`): [▶ Queue ×N]. runQueueFlow зовет
  `app.queuePrompt(undefined, N)` — ВАНИЛЬНАЯ семантика главной Queue:
  number опущен (append-at-back, сервер нумерует сам), batchCount=N.
  Отсутствие app.queuePrompt — мягкая деградация (console.warn + флэш ⚠).
  parseQueueCount: int ≥1, кап MAX_QUEUE_BATCH=1000; cfg.queueCount
  персистится (change и каждый клик коммитят значение поля); Enter в поле =
  запуск очереди. Высота бара включена в measureContent (по частям).

### Живой статус очереди и Cancel (v24)
- Источник истины — события на `app.api` (ПОЛЛИНГ ЗАПРЕЩЕН инвариантом #1):
  «status» → queue_remaining (парсер BFS до глубины 6 ловит и глубоко
  вложенные варианты payload'а, строковые числа), «execution_start»/
  «executing» → running=true, «execution_success/error/interrupted» →
  running=false. Подписка — `initQueueStatus(api)`, идемпотентна; вызывается
  из extension-хуков setup/afterConfigureGraph (в момент setup api уже есть).
- paintQueueBarDom обновляет ПОДОБРАННЫЕ DOM-узлы БЕЗ innerHTML-свапа
  (иначе убил бы открытые попапы): бейдж `.hub-queue-badge` (server
  queue_remaining), класс `hub-queue-live` на ▶, disabled у ⏹
  (`.hub-interrupt-on`) — активен пока running ИЛИ remaining>0.
- Cancel: `api.interrupt?.()` иначе `fetchApi("/interrupt",{method:"POST"})`;
  после успеха — оптимистичный setQueueState({running:false}) (серверная
  правда всё равно догонит событиями); нет ни того ни другого — флэш ⚠.
- Состояние модульное (qStatus), шарится ВСЕМИ хабами; paintAllQueues
  обходит allHubs().

### Комбо — читаемость длинных путей (v24)
- Закрытый триггер остаётся компактным (эллипсис), но title несет ПОЛНОЕ
  значение + подсказку фильтра (refreshValuesDom держит его в lockstep).
- Попап: `width:max-content; max-width:min(520px,88vw)` — растёт, а не режет.
- Опции ≥34 символов С разделителем пути — двухстрочные (`.hc-two`):
  `.hc-base` жирный basename + `.hc-dir` приглушенный моноширинный dirname;
  title каждой опции = исходная строка. Галочка текущего — CSS ::before
  (у .hc-two переносится на :first-child): textContent опций чище,
  НЕ засоряется символом ✓ (на это опираются ассерты фаз C/R).
- `splitComboPathText` экспортирован (контракт: {dir с сепаратором, base};
  null без разделителя). Порог/грамматика — в одном месте рендерера.

### Пин хаба на экран (v24)
- 📌 в таб-баре → `toggleHubPinned(node[, want])`: wrap-элемент DOM-виджета
  ПЕРЕНОСИТСЯ (appendChild, слушатели живут) в фиксированную панель
  `.hub-pin-panel` на document.body: заголовок с драгом (pointer capture,
  клэмп в вьюпорт), «–» collapse (cfg.pinMin), «📌» возврат. НЕ клонирование!
- Персист в конфиге (нормализация в getHubConfig): pinned / pinPos / pinMin;
  renderHub в хвосте сам переподнимает панель после reload.
- Нода-призрак: slimHubSlot сохраняет __prePinSize и жмёт слот до
  титульной строки; homeHub возвращает конверт ДО рендера — FILL-хабы
  (userH) обязаны получить ровно свой прежний размер (см. фазу ZF4),
  applyHubLayout при floating — ранний выход (панель правит геометрию).
- Collapsed нода НЕ прячет запиненный UI (guard в renderHub учитывает
  cfg.pinned). Удаление хаба — disposeHubVisuals из hub_node.onRemoved
  (никаких окон-сирот).
- v24.1 «плавающее окно оголилось после зум-аута»: DOM-виджет-менеджер
  фронта каждый кадр переписывает widget.element (прячет при мелком зуме/
  culled-ноде, вписывает геометрию слота — у призрака она ≈0). Пока wrap
  в панели, эти записи мусор. Контракт: на время плавания виджет ПАРКУЕТСЯ
  ИЗ node.widgets (detachHubWidget, индекс сохраняется), inline-мусор
  сбрасывается (resetWrapGeometry: display/left/top/height/… → "",
  width обратно "100%"), страховочный класс .hub-wrap-floating
  (!important-оверрайды по образцу .hub-portal-ghost). homeHub
  реаттачит виджет на прежний индекс ДО переноса wrap домой. renderHub
  перепарковывает, если конфигуратор вернул виджет в массив. ensureHubDom
  считает __widgetDetached здоровым состоянием (без дубликатов).
- v24.2 «содержимое пина возвращается В НОДУ после зум-циклов»: при
  плавании запрещено ЛЮБОЕ пересоздание DOM — ensureHubDom при cfg.pinned
  всегда переиспользует st (второй wrap в слот ноды больше не строится
  НИКОГДА, даже при потерянной реестровой записи); «страж дома»
  (MutationObserver на теле панели, armWrapHomeKeeper) возвращает yank
  wrap обратно в панель (событийно, без поллинга; homeHub/dispose
  дисконнектят ДО манипуляций, чтобы не перехватить своё же движение);
  slimHubSlot стал идемпотентно-перезапускаемым (__prePinSize
  фиксируется один раз, повторный вызов пересламывает внешне
  разросшуюся ноду); консольный крош (один за сессию) при эвакуации
  wrap обратно — для полевых репортов. Тест-хук __hubTestState(node).
- Известная грань: canvas-порталы рисуют через draw()-цикл ноды — при
  collapsed ноде их картинка в панели может замирать (не критично,
  порталы живут на видимых нодах).

### v27.2: ресайз плавающего окна (пин на экран)
- SE-грип `.hub-pin-resize` (16x16, absolute right-bottom; панель
  overflow:hidden — грип всегда внутри). Pointer-capture, тот же паттерн,
  что у драга заголовка: pointerdown (только ЛКМ, игнор при pinMin) →
  pointermove (clampPinSize) → pointerup/cancel = savePinSizeFromRect.
- Размер живёт в конфиге: `cfg.pinSize = {w,h} | null` (нормализация в
  getHubConfig рядом с pinPos). null = авто-режим: панель обнимает контент
  (старый CSS), max-height прежний. Не-null: панель получает inline
  width/height + класс `.hub-pin-sized` → тело становится flex-скроллом
  (max-height:none, flex:1, min-height:0).
- clampPinSize: min 280x120 (ниже ломается хром строк), max = вьюпорт -16/-40.
  floatHub применяет сохранённый размер при КАЖДОМ монтировании (reload,
  re-pin) — applyPinSize; dblclick по грипу = сброс в авто (pinSize=null).
- Инварианты: grip не мешает драгу окна (отдельный элемент, stopPropagation),
  collapsed скрывает грип (CSS) и pointerdown игнорирует, resize НЕ двигает
  окно (якорь top-left стабилен), hub-pin-resizing глушит pointer-events
  тела. homeHub/dispose ничего не чистят — размер переживает unpin/repin.

### v27.3: кнопки скачивания медиа + расширенный show/hide
- Скачивание: общий хелпер `downloadMediaUrl(url, fallbackBase)` в
  viewer_gallery.js. Предпочтительный маршрут fetch → blob → object-URL
  `<a download>` (точные байты, честное имя файла), фолбэк — прямой клик по
  `<a download>` (same-origin /view и blob: скачиваются и так). Имя файла:
  параметр `filename` из /view → basename URL → расширение из blob.type →
  `fallbackBase-<ts>`; blob:/data: имен не несут по определению.
- Кнопки: ⬇ в галерее (`.hub-gal-dl`, слева от ⛶, скачивает ТЕКУЩИЙ кадр
  батча), ⬇ в фуллскрине (`.hub-fs-dl`, слева от ✕, шорткат S/e.code=KeyS —
  раскладконезависимо), ⬇ поверх self-rendered `<video>/<img>` вьювера
  (`.hub-vid-dl`, portal_manager.js; handler читает el.currentSrc В МОМЕНТ
  клика — поколения медиа меняют src на месте; видна на hover/focus,
  release снимает кнопку вместе с записью).
- 👁 chrome-toggle теперь прячет ВЕСЬ авторский чром, а не только ручки
  строк: `.hub-gear` (⚙ min/max/step слайдера), `.hub-settings` (⚙ глобальных
  настроек), `.hub-add-divider` (＋Div, класс добавлен), `.hub-add-tab` (+
  таб). Селекторы расширены в правиле `.hub-chrome-hidden` (styles.css);
  делители-строки, пресеты, поиск, 👁/📌 остаются видимыми — это контент и
  управление самим режимом. Тогглится тем же cfg.hideChrome (v25).

### v27.4: ресайз multiline-текстовых полей
- Hub-зеркала (`.hub-text-area`): `resize: vertical` был в CSS и раньше, но
  каждый renderHub (innerHTML-свод) сбрасывал высоту к rows="3". Браузер
  пишет inline height при драге нативного грипа; pointerup/mouseup
  (делегирование на st.root в wireEvents) сохраняют округлённый px в
  `item.textH` — обычное поле item'а, сериализуется с графом. renderHub
  перед layout-пасом повторно применяет сохранённые высоты. Пустой inline
  height = «никогда не ресайзили» → ничего не пишем (дефолт не замораживается).
- Ghost-зеркала (DOM-порталы): то же для `<textarea>` внутри клона. Высоты —
  массивом `item.ghostTextHs` (по порядку querySelectorAll("textarea"));
  применяются после первичного монтирования и после КАЖДОГО rebuild
  (re-clone swap иначе сбрасывал к высоте исходного виджета). baseline-снимок
  сразу после применения отсекает ложные сохранения: клик без ресайза видит
  cur==base и не перезаписывает сохранённое исходной высотой. Снятие —
  pointerup/mouseup на корне клона (через rec.handlers → чистится в
  unbindClone).
- CSS: `.hub-portal-ghost textarea { resize: vertical !important;
  min-height: 46px; max-width: 100%; }` — CSS фронтенда может глушить
  resize для .comfy-multiline-input.
- Ширина намеренно НЕ ресайзится (vertical only): строка зеркала занимает
  всю ширину хаба, горизонтальный драг ломал бы раскладку строк.
- Фикс v27.4.1 (PromptChecker без грипа): `isMultilineWidget` смотрела
  только ПЕРВЫЙ ненулевой element-референс (`element ?? inputEl ??
  contentEl`) и флаг `options.multiline`. Новые сборки фронтенда флаг не
  ставят вовсе, а референсы различаются между версиями (element с PR #8594,
  inputEl раньше; часть слоёв не экспонирует элемент до маунта) → prompt
  рендерился однострочным `.hub-text-input` без грипа. Теперь multiline =
  ЛЮБОЙ референс-textarea, `type=="customtext"` по определению multiline,
  а обёртка-div с textarea внутри засчитывается ТОЛЬКО для TEXT_TYPES
  виджетов (панели с textarea внутри не переворачиваются в текст-зеркала).
  Плюс ghost-КОРЕНЬ может быть самой textarea (element==editor): её включил
  ghostTextareas() и CSS `textarea.hub-portal-ghost`.

### v28: Presets 2.0 — пресеты по вкладкам: opt-out, инспекция, undo, тулзы
- ФОРМАТ (v2): cfg.presets[name] = { v: 2, ts, scope: <tabId>, entries:
  [{ itemId, label, widgetType, value, nodeId, widget }] }. ПЛОСКИЙ
  {itemId: value} НЕ читается намеренно (старых пресетов не существовало —
  решение пользователя). Хранение по-прежнему в cfg.presets (с графом).
- SCOPE = АКТИВНАЯ ВКЛАДКА: захват (💾) снимает только value-байндинги
  itemsOfTab(cfg, cfg.activeTabId); кнопки/порталы/делители не захватываются
  (как и в v1). Применение пишет только свои entries — чужие вкладки не
  трогает.
- OPT-OUT (вариант А): в пресет по умолчанию попадают ВСЕ value-контролы
  вкладки; у каждой строки value-байндинга чекбокс .hub-inpreset («include
  in presets»): unchecked → item.inPreset = false (строка никогда не
  захватывается), checked → флаг удаляется (участвует). Флажок — авторский
  чром: скрывается 👁 (правило .hub-chrome-hidden). НЕ data-hub-control
  (значение не носит) — отдельная ветка в change-листенере рендерера.
- ЗАХВАТ с ПОДТВЕРЖДЕНИЕМ: перезапись существующего имени — только после
  confirm «Overwrite "X"? (N value(s) from tab "Y")» (в v1 было молчаливо).
- ПРИМЕНЕНИЕ = ИНСПЕКЦИЯ: выбор в дропдауне больше НЕ применяет мгновенно —
  открывается поповер .hub-preset-pop (body-level fixed, паттерн combo/
  gear/set-попапов). Каждая entry — строка с чекбоксом, статусом и превью:
  ✓ ok / ⚠ missing-item (строки нет) / ⚠ missing-widget (нода/виджет не
  найдены) / ⚠ combo-invalid (значения нет в liveComboValues — skip).
  Дрейф-маркер «≈» если значение изменилось с момента захвата. [Apply N]
  пишет только отмеченные строки (ЧАСТИЧНОЕ ПРИМЕНЕНИЕ), затем отчёт
  «Applied M of N (−K skipped)». Все записи — writeTargetValue под общим
  edit-lock + refreshNodeValues после батча (инвариант 2 не нарушается).
- STABLE-KEY FALLBACK (Ф3): entry резолвится по itemId; если строка умерла
  (перепин) — по паре nodeId + widget (тот же байндинг той же ноды).
  presetCountDead / presetCleanDead считают «мёртвым» только entry,
  неразрешимое ОБЕИМИ путями.
- UNDO: один уровень, ПАМЯТЬ МОДУЛЯ (не cfg — не раздувает workflow и не
  переживает reload намеренно). Снапшот берётся ДО первой записи и только
  затронутых строк; кнопка ↩ в ряду пресетов появляется сразу после
  применения (ряд перерисовывается точечно outerHTML-заменой, без полного
  renderHub), клик восстанавливает значения и расходует undo (кнопка
  удаляется).
- ВАЛИДАЦИЯ/КЛЭМП: int/float/slider/number — coerceNumeric (границы виджета
  + пользовательские override'ы, int округляется), checkbox — !!, текст —
  String; combo — значение обязано быть среди liveComboValues, иначе skip.
- ТУЛЗЫ (⋯ в ряду пресетов, body-level .hub-preset-tools): Rename (порядок
  ключей сохраняется перестройкой карты), Duplicate (глубокая копия),
  Clean dead entries (confirm с количеством), Export all (JSON-блоб
  settings-hub-presets.json, формат {kind, version: 2, presets}),
  Import (файл → presetImportFromText: wrapped или голый map, overwrite
  только после confirm; ошибки — console.warn + flash ⚠).
- Пресет-ряд: select | 💾 | ➕ | ↩ (условный) | 🗑️ | ⋯ | ＋Div | ⚙.
  Титул 💾 обновлён (ACTIVE tab + opt-out).

### v42: протухшие пин-окна — вотчер свипает каждый тик, ре-флоат подчиняется живости строк
- ЗАПРОС (поле): «когда хаб свернут запиненный хаб, то при смене
  рабочего процесса он остается на экране» — свёрнутый
  (авто-сворачивание v41 или «–») пин переживает смену воркфлоу.
- ДИАГНОЗ (repro_v42_fold.mjs, 9 симуляций, B6 воспроизвёл баг):
  две дыры, обе collapse-агностичны, но всплыли именно с v41
  (авто-сворачивание держит окно свёрнутым, когда пользователь
  тянется к вкладкам воркфлоу — «старый стрип» и виден):
  (а) v36 гейтил свип по id-хэш-сигнатуре корней — переключение
  на воркфлоу с ТЕМИ ЖЕ id нод (копия воркфлоу, повторная
  десериализация В ТОТ ЖЕ LGraph) не двигало сигнатуру, свип не
  запускался, мёртвое окно висело; живость — это членство
  node-ОБЪЕКТА в identity active-наборе, и его ребилд нельзя
  гейтить сигнатурой. (б) ре-флоат-ветка «pinned && !floating»
  ВОСКРЕШАЛА окно, только что снятое правилом all-rows-dead:
  каждая сигнатурная встряска поднимала его, следующая опускала
  (пинг-понг, ведомый правками графа).
- РЕШЕНИЕ (patch_v42_watchdog.py, CRLF-safe, 8 патчей):
  hub_ui_renderer.js installHubTabWatch — свип на КАЖДОМ тике
  (1.2s): rootSig/lastSig удалены, identity active-set
  ребилдится безусловно (bounded live-tree walk liveGraphs v37 —
  дёшево даже на больших графах); гварды v36/v37 сохранены
  дословно (everActive: до первой встречи нод — только
  наблюдение; пустой читаемый граф = РЕАЛЬНОЕ состояние;
  hiccup читаемых корней — только наблюдение; self-disarm после
  5 сломанных тиков). Ре-флоат-ветка гейтится
  pinnedWindowAllRowsDead: мёртвые строки — окно остаётся
  снятым (пин жив, возврат строк ре-флоатит); живые — прежний
  путь floatHub/syncNode. Новый бредкрамб foreign-снятия (раз за
  сессию): «pinned hub window closed: its hub node is not part
  of the current workflow anymore». hub_node.js setup-коммент
  отражает новый контракт; баннер v42, styles.css?v=42.
- smoke_v42.mjs (17 чеков): A1 SAME-ID blind spot (свитч с теми
  же id {2,3} без lifecycle и хуков — старый вотчер спал),
  A3 folded-parity (свитч свёрнутого через кнопку «–»),
  B1-B3 resurrection gate (снятие за мёртвые строки -> правка
  графа НЕ воскрешает -> возврат строк ре-флоатит), C1
  foreign-бредкрамб ровно один за сессию, D1-D7 wiring (баннер
  v42 до импортов, ?v=42, rootSig/lastSig отсутствуют,
  everActive/active.has сохранены, гейт ре-флоата, self-disarm).
- Регресс: v41(30)/v40(28)/v39/v38/v37(22)/v36/v35/v33/v32/v31/
  v30, repro_v37_field(12), text_resize, presets_v29, ghost_lock,
  ghost_prefix, canvas_route, resize_pin, media_dl_chrome(29) —
  ALL PASSED; node --check web/*.js. Баннер-чеки восьми смоуков
  подняты до v42; v36 C4 переключён с «rootSig присутствует» на
  «every-tick контракт».
- Коммит: «fix(hub): v42 stale pinned windows - the tab watcher
  sweeps every tick (same-id workflow switches are caught now)
  and a window taken down for dead rows stays down (edits no
  longer resurrect it); folded windows included».

### v41: авто-сворачивание запиненного хаба (auto-collapse)
- ЗАПРОС (поле): добавить режим автосворачивания запиненного
  хаба, когда курсор уходит за пределы хаба, и разворачивание,
  когда курсор попадает на заголовок свернутого хаба.
- РЕШЕНИЕ (patch_v41_autohide.py, CRLF-safe, 13 патчей): режим
  per-hub, персистентный cfg.pinAutoHide (нормализация в
  getHubConfig по образцу pinMin). Кнопка «⇲» в шапке пин-панели
  (между заголовком и «–») - тоггл режима; ON-состояние =
  янтарный акцент (семейство hub-pin-on), тултип отражает
  состояние. applyPinMin(node, p, min) - ЕДИНАЯ точка
  collapse/expand: и ручная «–», и авто-движок идут через неё
  (контракт v31 сохранён: складывание сбрасывает явный бокс,
  разворачивание возвращает персистентный размер). Движок
  (per-panel, в ensurePinPanel): mouseleave панели -> fold через
  PIN_AUTOHIDE_LEAVE_MS=450 (grace от случайных выходов);
  re-enter панели в срок отменяет отложенный fold; mouseenter на
  заголовке СВЕРНУТОГО окна -> expand через
  PIN_AUTOHIDE_HOVER_MS=220 (hover intent), head-mouseleave
  отменяет. Гварды: drag/resize в полёте (mouseleave под
  pointer-capture не сворачивает; endDrag/endRsz запускают
  autoHideCheck - драг, закончившийся вне панели, сворачивает
  окно, «проглоченный» mouseleave восстанавливается);
  body-попапы .hub-menu/.hub-batch/.hub-toast/.hub-fs-overlay
  (комбо/пресет-пикеры, batch-бокс, тост, фуллскрин-галерея живут
  ВНЕ панели - работа с ними не сворачивает хаб; проверка и на
  schedule, и на fire); fire-гварды живости (pinned,
  isConnected). homeHub/disposeHubVisuals отменяют отложенный
  таймер через p.cancelAuto().
- УРОК СМОУКА: jsdom 30 (dom-selector) трактует :hover как
  «последнее click/mousedown/mouseup/mouseover событие с target
  внутри элемента» (currentEvent персистентен!) -
  matches(":hover") НЕ всегда false; позицией курсора в тесте
  управляют диспетчем mouseup на нужном хосте (body = курсор вне
  окна). Клик по кнопке режима сам ставит hover на панель =>
  включение НЕ сворачивает окно (и в реальном поле тоже).
- smoke_v41.mjs (30 чеков, jsdom): wiring (кнопка ⇲, дефолт OFF,
  тултипы), включение не сворачивает, leave->fold с grace,
  hover заголовка свернутого разворачивает + отмена intent,
  re-entry отменяет fold, попапы блокируют fold, drag-гвард +
  endDrag-recovery (mouseup на body = отпускание вне окна),
  режим OFF замораживает оба направления, контракт v31 через
  applyPinMin (персистентный размер, сброс бокса),
  teardown-гигиена (unpin с отложенным fold), персистентность
  через re-pin, wiring (баннер v41, ?v=41, css-правило,
  константы).
- Регресс: v40/v39/v38/v37/v36/v35/v33/v32/v31/v30 (баннер-чеки
  семи смоуков подняты до v41), text_resize, presets_v29,
  ghost_lock, ghost_prefix, canvas_route, resize_pin,
  media_dl_chrome, repro_v37_field - ALL PASSED;
  node --check web/*.js.
- Коммит: «feat(hub): v41 auto-collapse for the pinned hub -
  toggle the ⇲ button and the window folds itself when the
  cursor leaves …».

### v40: канвас-виджетлесс ноды в хабе — «Pin node UI (live embed)»
- ЗАПРОС (поле): у ноды Switch Pixaroma не появляется никакой пункт
  для выноса в хаб; проверить остальные ноды пака Pixaroma на
  похожую проблему.
- ИЗУЧЕНИЕ ПАКА (gitlab.com/pixaroma/ComfyUI-Pixaroma, 82 класса):
  Switch Pixaroma (js/switch/) и Mute Switch Pixaroma
  (js/mute_switch/) в legacy-рендере НЕ имеют ни одного виджета:
  все входы forceInput-сокеты + hidden SwitchState, DOM-строки
  (vue_list.mjs) строятся ТОЛЬКО в Nodes 2.0 (isVueNodes), а в
  legacy строки рисуются node.onDrawForeground и хит-тестятся в
  node.onMouseDown (hitToggle/hitLabel). Все точки входа хаба
  виджетные -> пункт не появлялся ни один. Остальные ноды пака
  получают JS-виджеты или безусловные addDOMWidget DOM-панели ->
  пути Pin/panel-pin уже работали. Фронтенд 1.51.9
  collectNodeMenuItems = invokeExtensions('getNodeMenuItems').flat()
  - собственные хуки пака (mute/group switch) КОНКАТЕНИРУЮТСЯ с
  нашим, подавления нет.
- РЕШЕНИЕ (patch_v40_nodeui.py, CRLF-safe, 11 патчей): v32+
  canvas-портал УЖЕ умеет рисовать onDrawForeground 1:1 и
  форвардить указатель в node-хендлеры с node-local координатами
  (контракт этих нод) - пин делается ЖИВЫМ И ИНТЕРАКТИВНЫМ.
  core.js: createNodeUIBinding (viewer-форма: VIEWER_SENTINEL +
  options.viewer, ПЛЮС options.controls) - вся обвязка viewer-строк
  (рендер, orphan-гейты, персистентность, exclusion из пресетов)
  работает без изменений. context_menu.js: isNodeUIPinCandidate
  (НЕ mediaLoaderInfo, НЕ isViewerNode, onDrawForeground-функция,
  listBatchWidgets ПУСТ - любой зеркалируемый виджет делает
  canvas-embed деградацией) + пункт «🎛 Pin node UI (live embed)» +
  buildNodeUISubmenu (общее тело node-embed подменю с viewer).
  portal_manager.js: mountNodeUIPortal - СРАЗУ форграунд-пейнтер
  (painterWidget.draw = onDrawForeground; rec.mode = "foreground"
  с тика 1: полный size[1] как база высоты), controls-биндинги
  монтируются МИМО media/gallery попыток; форвардинг и авто-высота
  достаются от mountCanvasPortal без изменений. hub_ui_renderer.js:
  тег строки «🎛 live» + label-fallback "node UI". settings_hub:
  баннер v40 + styles.css?v=40.
- smoke_v40.mjs (28 чеков, jsdom + pixel-accounting ctx-стаб):
  меню-квалификация (Switch = ровно один пункт; Mute Switch тоже;
  негативы: combo/panel/viewer/media ноды НЕ дают дубля, хаб-нода
  немая), биндинг (viewer-shape + controls, якоря id/title),
  монтаж (canvas в хосте, onDrawForeground реально красит,
  тег выживает), ИНТЕРАКТИВНОСТЬ (pointerdown -> onMouseDown с
  node-local pos [100,55], wheel/contextmenu гасятся, pointerleave
  -> onMouseLeave), релиз-гигиена (ремаунт без гостов, анпин
  чистит), wiring (баннер v40, ?v=40, тег, экспорт). Уроки:
  jsdom document.hidden=true - tick() не красит (нужен стаб);
  подменю снапшотят allHubs() на момент построения - в смоуке хаб
  должен существовать ДО построения меню; properties-LESS
  SettingsHub-фикстура в графе роняет getHubConfig в фолбэк-скане.
- Регресс: v39/v38/v37/v36/v35/v33/v32/v31/v30 (баннер-чеки
  подняты до v40), text_resize, presets_v29, ghost_lock,
  ghost_prefix, canvas_route, resize_pin, media_dl_chrome,
  repro_v37_field - ALL PASSED; node --check web/*.js.
- Коммит: «feat(hub): v40 canvas-drawn widgetless nodes get a
  node-UI pin - Pixaroma Switch / Mute Switch join the hub LIVE …».

### v39: TrixLoader «Load Image AIO» в media-строках хаба
- ЗАПРОС (поле): сделать поддержку загрузчика 🌊Load Image AIO из
  нодпака ComfyUI-TrixLoader (github.com/trx7111/ComfyUI-TrixLoader) -
  для него не отображается «Pin media source».
- ИЗУЧЕНИЕ ПАКА (trix_loader_nodes.py + web/js/trix_loader_ui.js):
  combo "image" - ОБЫЧНЫЙ combo БЕЗ image_upload-флага; стандартная
  upload-кнопка SPLICE-ится из node.widgets (override addWidget прячет
  "choose file to upload"/"upload"), видимая кнопка - кастомный DOM;
  upload-композаблы фронта на нём не запускаются: НЕТ инстанс-пар
  onDragOver/onDrop и НЕТ node.pasteFiles (свой paste - пункт меню,
  сам дергает /upload/image). Единственная проводка - лайтграфовский
  хук node.onDropFile = (file) => {...} (инстанс-проп из onNodeCreated;
  его пайплайн: /upload/image type=input, combo unshift + callback,
  свой превью-рефреш). mediaLoaderInfo() возвращал null -> пункта
  меню и batch-строки не было.
- ФИКС (patch_v39_trix.py, CRLF-safe): core.js mediaLoaderInfo -
  сигнал ownDropFile (hasOwnProperty "onDropFile", строго инстанс:
  прототип-хук НЕ квалифицирует); viewer_gallery.js firstMediaSpec(tn,
  wantType) - опц. фильтр типа стора (после прогона Trix кладёт в стор
  ОБРАБОТАННЫЙ output - для строки источника нужна input-спека);
  hub_ui_renderer.js: uploadMediaFiles Route A2 (один вызов
  tn.onDropFile(file) на файл НАТТИВНОГО пайплайна; decline(false)/
  throw -> /upload/image Route B; успех - отложенный repaint 800мс,
  без тоста - у пака своя индикация); paintMediaPreview -
  firstMediaSpec(tn, "input") + фолбэк /view с парсингом
  subfoldered combo-значений ("aio_input/x.png" -> subfolder+filename);
  settings_hub - баннер v39 + styles.css?v=39.
- smoke_v39.mjs (18 чеков): детекция Trix-AIO (plain combo + инстанс
  onDropFile), негативы (combo без проводки; onDropFile без
  mediaish-combo; ПРОТОТИП-хук не квалифицирует), биндинг; Route A2
  через paste-P3 (нативный контракт: fetch НЕ вызван, combo пишет сам
  пак; decline -> фолбэк /upload/image + combo-запись; throw ->
  фолбэк); превью (input-фильтр выбирает спеку источника; без фильтра
  - v30-поведение; output-only стор -> null; subfoldered и plain
  combo-значения дают точный /view-контракт); wiring (баннер v39,
  ?v=39, Ctrl+V в тултипе). Урок: Route B пишет ПУТЬ ОТ СЕРВЕРА -
  fetch-стаб должен возвращать имя, ожидаемое ассертом.
- Регресс: v38/v37/v36/v35/v33/v32/v31/v30, text_resize,
  presets_v29, ghost_lock, ghost_prefix, canvas_route, resize_pin,
  media_dl_chrome, repro_v37_field - ALL PASSED; node --check web/*.js.
- Коммит: «feat(hub): v39 TrixLoader Load Image AIO - media-source pin
  via the pack's own onDropFile hook …».

### v38: вставка из буфера обмена (Ctrl+V) в media-строки хаба
- ЗАПРОС (поле): input-виджет картинки/видео в хабе с поддержкой
  вставки из буфера; ноды-загрузчики это умеют. База: v30 уже даёт
  media-строку (превью + searchable combo + 📁 пикер + drag&drop) —
  не хватало только paste.
- ИЗУЧЕНИЕ ИСХОДНИКОВ 1.51.9 (Comfy-Org/ComfyUI_frontend @ v1.51.9):
  usePaste слушает paste на document в BUBBLE-фазе и НЕ зовёт
  preventDefault — при media-клипборде он вставляет в ВЫБРАННУЮ на
  канвасе ноду-загрузчик или СОЗДАЁТ НОВУЮ LoadImage/LoadVideo;
  ноды-загрузчики несут node.pasteFiles(files) (useNodePaste через
  useNodeImageUpload): kind-фильтр, батч, /upload/image (скриншоты —
  в subfolder 'pasted'), запись combo, обновление превью; возвращает
  false, если все файлы отфильтрованы. shouldIgnoreCopyPaste:
  textarea/текстовый input = системный paste, не трогать.
- ФИКС (patch_v38_media_paste.py, CRLF-safe): hub_ui_renderer —
  mediaPasteArm {node, itemId, zone}; pointerover/pointerout-делегация
  в wireEvents (hover армит строку, выход за пределы — разоружает);
  installMediaPasteCapture — ОДИН document-capture листенер 'paste';
  routeMediaPaste — гарды (shiftKey = litegraph paste; editable-target
  = системный paste; файлы через clipboardData.files с фолбэком
  items.getAsFile; arm.zone.isConnected против перерендера), порядок
  целей [armed, остальные media-строки хаба], kind-матч файла строке
  (image/video/audio); mediaPasteInto — P1 tn.pasteFiles(files) !==
  false → P2 legacy tn.pasteFile → P3 uploadMediaFiles (v30-пайплайн,
  сам тостит); P1/P2 тостят «Pasted N file(s) → …» + отложенный
  paintMediaPreview; при захвате — preventDefault +
  stopImmediatePropagation (upstream не видит событие, новая
  LoadImage не спаунится); тултип 📁 дополнен Ctrl+V-подсказкой;
  settings_hub — баннер v38 + styles.css?v=38.
- smoke_v38.mjs (16 чеков): wiring (баннер v38, ?v=38, Ctrl+V в
  тултипе); paste без hover не перехватывается; hover-arm роутит в
  node.pasteFiles (аргументы точные), preventDefault + bubble-шпион
  молчит, тост «Pasted», combo хабом не тронут (нативный контракт);
  гарды: editable-фокус, Shift+Ctrl+V, paste без файлов, pointerout;
  kind-фоллтринч (video-файл при hover image-строки уходит в
  video-строку: Route B — fetch, combo, тост «Uploaded»); отказы P1
  (pasteFiles()==false и кидающий) падают в /upload/image. Урок:
  в jsdom шпион на document регистрируется ПОСЛЕ capture-листенера,
  поэтому defaultPrevented проверяется на собственном событии.
- Регресс: v37 22/22, v36/v35/v31 (баннер-чеки подняты до v38),
  v33, v32, v30, text_resize, presets_v29, ghost_lock, ghost_prefix,
  canvas_route, resize_pin, media_dl_chrome — ALL PASSED;
  node --check web/*.js. check_imports.mjs: 9 предупреждений
  «non-web target ../../scripts/app.js» — старое поведение чекера
  (воспроизводится и на чистой v37-базе), к v38 отношения не имеет.
### v37: пин-окна умирают вместе со своим воркфлоу (поле: frontend 1.51.9) + бредкрамбы ждут заселения графа
- РЕПОРТ (поле, после v36, frontend package 1.51.9): проблема «пин окна
  остаются при смене рабочего процесса» НЕ решена; лог: 5x «pin
  unresolved {KSampler…} - scanned 1 graph(s), 0 node(s)» + строка
  «floating hub content was pulled back to the canvas…». Пользователь
  сообщил версию фронта (1.51.9) — по запросу диагностики v36.
- ИЗУЧЕНИЕ ИСХОДНИКОВ 1.51.9 (Comfy-Org/ComfyUI_frontend @ v1.51.9):
  app.graph — СИНГЛТОН rootGraphInternal, identity НЕ меняется НИКОГДА
  (v35-урок подтверждён); переключение вкладок = workflowService.
  openWorkflow -> app.loadGraphData -> clean() + rootGraph.configure()
  НА ТОМ ЖЕ LGraph; хуки before/afterConfigureGraph ЗОВУТСЯ; clean()
  зовёт rootGraph.clear() ТОЛЬКО при !canvas.subgraph (clear() в 1.51.9
  честно зовёт fireNodeRemovalLifecycle -> onRemoved), а configure()
  заменяет _nodes БЕЗ lifecycle и ДОЛИВАЕТ сабграф-дефиниции в
  root._subgraphs НЕ ЧИСТЯ реестр (при пропущенном clean() там
  остаются сабграфы ПРЕДЫДУЩЕГО воркфлоу); LGraphCanvas.setGraph не
  трогает canvas.subgraph.
- ДИАГНОЗ (три механизма выживания, воспроизведены в jsdom на живом
  коде расширения — repro_v37_field.mjs):
  1) configure БЕЗ lifecycle (clean() пропущен) оставляет мёртвый хаб в
     реестре с плавающим окном; renderHub (блок pinned) РЕ-ФЛОАТИТ ЛЮБОЙ
     хаб с pinned:true — syncAll/onConfigure воскрешали мёртвое окно;
  2) СТЕЙЛ-РЕЕСТР ПОДГРАФОВ: allGraphs() черпает и _subgraphs — мёртвый
     хаб внутри сабграфа прошлого воркфлоу читался «достижимым» ->
     hubIsReachable отвечал true -> prune ЩАДИЛ его, вотчер считал его
     ноды «активными» (re-float ветка);
  3) КОПИРОВАННЫЕ КОНФИГИ хаба (дублированные воркфлоу): каждая копия
     легитимно ре-флоатит СВОЁ окно с ЧУЖИМИ привязками — окно «с
     прошлого процесса» висит над новым воркфлоу с мёртвыми строками.
- РЕШЕНИЕ (v37, примитивы v33/v36 не тронуты):
  1) core.liveGraphs() — обход ТОЛЬКО живого дерева (корни + сабграфы,
     на которые ссылаются СОБСТВЕННЫЕ свойства живых нод; реестры
     дефиниций НЕ обходятся) + core.isNodeInLiveTree(node) (сбой
     walker'а отвечает «да» — живое состояние не уничтожается);
     РЕЗОЛЮЦИЯ ПИНОВ по-прежнему через allGraphs() (v24 контракт,
     пины внутри сабграфов ищутся как раньше);
  2) renderHub: блок pinned гейтируется живостью — мёртвый хаб НЕ
     флоатит, плавающий мёртвый — forget+dispose (воскрешение закрыто
     во ВСЕХ порядках хуков);
  3) syncAll: перед syncNode мёртвые хабы forget+dispose (sync_manager);
  4) hubIsReachable = isNodeInLiveTree (prune щадит только живых);
  5) вотчер: active-множество из liveGraphs(); НОВАЯ ветка — пин-окно,
     у которого НИ ОДНА строка не резолвится на заселённом графе
     (копированный конфиг), снимается homeHub'ом (pin выживает,
     возврат ре-флоатит), один console.info за сессию; пустой хаб и
     незаселённый граф НЕ закрываются (pinnedWindowAllRowsDead);
  6) disposeHubVisuals обнуляет st.panelBody (isWrapInPanel больше не
     врёт «floating» после dispose);
  7) core.reportUnresolved v2: скан с 0 узлов = граф ещё не заселён
     (тяжёлые окружения бутятся дольше 2.5с) -> РЕ-АРМ (до 2 раз) вместо
     репорта; бредкрамб только по заселённому графу (diagAttempts).
- СМОУКИ: smoke_v37.mjs 22 чека (A1-A7: lifecycle-свитч, свитч без
  lifecycle, syncAll-до-prune, вотчер-only, стейл-подграфы, копиконфиг
  + возврат ре-флоат, одна живая строка держит окно; B1-B3: тишина на
  пустом графе, поздний таргет исцеляется молча, вечный сирота на
  заселённом графе — ровно один честный бредкрамб; C: баннер v37,
  ?v=37, гейты на месте). repro_v37_field.mjs — полевой стенд с точной
  семантикой 1.51.9. Регресс: v36, v35, v33, v32, v31, v30,
  text_resize, presets_v29, ghost_lock, ghost_prefix, canvas_route,
  resize_pin, media_dl_chrome — ALL PASSED (пины версий в v36/v35/v31
  подняты до v37); node --check web/*.js.
- ВЕРИФИКАЦИЯ НА ПОЛЕ: F12 -> баннер «web build: v37 - pinned windows
  die with their workflow…»; полная замена web/ из zip + Ctrl+F5.

### v36: полевой фикс tab-watcher (смена вкладок БЕЗ смены identity графа) + отложенные pin-unresolved репорты
- РЕПОРТ (поле, после v35): batch-add работает; ОСТАТОЧНОЕ — «при смене
  процесса (переключаюсь на другую вкладку) пин окошко хаба остается на
  экране с прошлого процесса»; приложен лог консоли: ~35 строк
  «[SettingsHub] pin unresolved … scanned 1 graph(s), 0 node(s)» на каждый
  пин хаба при загрузке страницы.
- ДИАГНОЗ 1 (вотчер): v35-вотчер гейтился на IDENTITY корней
  (root === lastRoot && canvas === lastCanvas). Фронты, которые
  ре-десериализуют входящий воркфлоу В ТОТ ЖЕ LGraph-объект, не меняют
  identity (и не зовут configure) — вотчер спал ровно на тех переключениях,
  ради которых строился. jsdom-смоук E2 проходил, потому что тесты меняли
  graph identity, а не содержимое на месте.
- ДИАГНОЗ 2 (спам): хаб рендерится ВО ВРЕМЯ graph.configure
  (onConfigure -> syncNode), когда таргет-ноды ещё не существуют; каждый
  немедленный репорт в этом окне — ложная тревога, которая лечится через
  миллисекунды послеурепортным afterConfigureGraph -> syncAll.
- РЕШЕНИЕ (примитивы v33 не тронуты):
  1) installHubTabWatch v2: решение о смене — по СИГНАТУРЕ СОДЕРЖИМОГО
     корней (id-hash списков узлов app.graph + app.canvas.graph,
     Math.imul; любое исключение -> «!» = свип форсируется). Полный свип
     (active = узлы allGraphs) — только при смене сигнатуры; steady-state
     тик почти бесплатен. Идемпотентен: свой пин -> floatHub/syncNode при
     needs, чужой с плавающим wrap -> homeHub (cfg.pinned ВЫЖИВАЕТ);
  2) ПУСТОЕ, но ЧИТАЕМОЕ множество — реальное состояние (новый пустой
     воркфлоу/закрытая вкладка): чужие плавающие окна уходят. Гард
     everActive: пока ни одного узла в сессии не видели ИЛИ корни
     нечитаемы (null) — observe-only (сбой walker'а окна не закрывает);
  3) core.reportUnresolved: ОТЛОЖЕН на ~2.5с с re-check
     (resolveBindingTarget по тому же item). Исцелившиеся — молча;
     выжившие — ОДИН бредкрамб с честной статистикой (свежий
     scanAllNodesFor: nodeId-only пины сами статистику не копят).
     diagPending (WeakSet) против ре-ентри; diagReported против дублей.
- СМОУКИ: smoke_v36.mjs 19 чеков (A watcher на РЕАЛЬНЫХ тиках: in-place
  иностранный своп снимает окно за тик — ГЛАВНЫЙ полевой кейс, возврат
  ре-флоатит, читаемо-пустой граф снимает, null-корни observe-only;
  B отложенные репорты: тишина <300мс, исцеление молча, ровно ОДНА строка
  для вечного сироты с «scanned 1 graph(s), 3 node(s)», без дублей;
  C wiring: баннер v36 до импортов, ?v=36, prune+watcher на месте, нет
  остатков identity-гейта). smoke_v35: E-секция переведена на контракт
  v36 (читаемо-пустой = реальный свитч, добавлен E4b null-корни), D5/D8
  -> v36; smoke_v31 F1 -> v36. Регресс: v35, v33, v32, v31, v30,
  text_resize, presets_v29, ghost_lock, ghost_prefix, canvas_route,
  resize_pin, media_dl_chrome — ALL PASSED; node --check web/*.js.
- ВЕРИФИКАЦИЯ НА ПОЛЕ: F12 -> баннер «web build: v36 - …»; полная замена
  web/ из zip + Ctrl+F5.

### v35: откат v34 + консервативная пересборка — batch-пикер на базовом контракте, самоотключающийся tab-watcher, громкий загрузчик
- РЕПОРТ (поле, после v34): «полностью бракованный коммит, поломал вообще
  всё» — загрузка старого воркфлоу с сохранённым пином НЕ восстановила
  привычный интерфейс хаба; на экране висел один DOM-портал кастом-ноды
  (пол-экрана, неотзакрываемый, переживал смену воркфлоу); пункты
  «добавить в хаб» исчезли И у виджетов, И у нод; лог консоли — ЧИСТЫЙ:
  ни баннера пакета, ни одной ошибки.
- ДИАГНОЗ: (а) ноль строк пакета в логе при живом расширении невозможен —
  статический граф импортов умирает ДО баннера (стале-кэш/неполная копия
  web/ = «всё мёртвое, лог чистый»); (б) сама машинерия v34 (weak-реестр,
  identity-sweep с re-float/livePinPanels, activeHubs-гейтинг ВСЕХ
  пин-меню) — слишком много одновременных изменений жизненного цикла без
  полевой страховки.
- РЕШЕНИЕ: полный revert e05fa9b (6b7e041) к v33-бейзлайну; v35 собирает
  то же пользовательское поведение из примитивов v33:
  1) batch-пикер возвращён ADDITIVE: цели = allHubs() (как у всех меню),
     createBindingsBulk (N items, ОДИН syncNode), getter-гарды
     (findWidgetOnNode/sameNameOrdinal — экзотический виджет с кидящим
     name-геттером больше роняет только себя), CSS .hub-batch-*; НИЧЕГО
     из этого не касается жизненного цикла хаба;
  2) tab-watcher installHubTabWatch (hub_ui_renderer) вместо sweep:
     тик 1.2с ТОЛЬКО при смене identity активных корней; active = узлы
     allGraphs() (текущие корни + сабграфы — семантика v34, которая была
     верной); ПУСТОЕ/нечитаемое множество = observe-only (сбой walker'а
     не закрывает окна); чужой пин -> homeHub (cfg.pinned ВЫЖИВАЕТ,
     возврат ре-флоатит на pinPos); свой -> floatHub / syncNode-rebuild;
     5 подряд сбоев -> самоотключение + console.warn; setup() ставит,
     afterConfigureGraph сохраняет v31-prune;
  3) settings_hub.js -> ЗАГРУЗЧИК: баннер ПЕРВЫМ (свежесть entry
     доказуема даже при сбое подмодуля), top-level await import каждого
     модуля с try/catch — сбой называет точный файл; частичная загрузка
     НЕ регистрирует hooks; JS-импорты без query (другой specifier =
     ВТОРОЙ инстанс модуля = расщепление состояния), styles.css?v=35;
  4) УРОК TLA: ComfyUI ждёт import(entry) до конца ОЦЕНКИ модуля —
     fire-and-forget IIFE зарегистрировал бы расширения ПОСЛЕ
     app.setup(); только top-level await сохраняет тайминги статического
     графа.
- ВЕРИФИКАЦИЯ НА ПОЛЕ: F12 -> баннер «web build: v35 - …»; при частичной
  копии/стале-кэше консоль ЯВНО назовёт файл: «FAILED to load ./x.js»;
  при старом баннере — Ctrl+F5 (кэш).
- СМОУКИ: smoke_v35.mjs 35 чеков (A bulk + evil-виджет; B пикер;
  C сильный реестр v33 — forget/re-track с учётом graph-scan фолбэка
  allHubs; D wiring/loader — prune в afterConfigureGraph, watcher в
  setup(), sweep ОТСУТСТВУЕТ, TLA без IIFE, без query у JS; E watcher на
  РЕАЛЬНЫХ тиках 1.45с: чужой воркфлоу снимает окно за тик, pin
  выживает, пустое множество = observe-only, возврат ре-флоатит);
  smoke_v31 C-секция возвращена на prune-контракт (C1-C8, F1 -> v35);
  регресс: v33 24, v32 17, v30 35, text_resize 34, presets_v29 78,
  ghost_lock 8, ghost_prefix 8, canvas_route 2, resize_pin,
  media_dl_chrome 29 — ALL PASSED; node --check OK.
- КОММИТ: revert 6b7e041 + v35 (см. git log).

### v33: зеркала сплит-превью переживают CSS хаба — Model Preview Override исправлен по-настоящему
- РЕПОРТ (после v32): «в поведении превьюхи в хабе ничего не изменилось» —
  инфо-панель по-прежнему поверх картинки; драг разделителя растит панель,
  а сам разделитель стоит на месте.
- КОРЕНЬ (каскад): v32 честно ставил корню клона inline height, но
  normalizeGhostMedia вешал на клон с <img>/<video> класс .hub-portal-media
  (флейвор viewer-встраиваний), а тот несёт
  `.hub-portal-ghost.hub-portal-media { height:auto !important }` —
  АВТОРСКИЙ !important СИЛЬНЕЕ обычного inline-стиля. Высота зеркала молча
  отменялась: flex-колонке нечего было распределять, зона картинки
  схлопывалась в min-height 80px, панель забирала остальное; драг росил
  панель ВНИЗ (зоне картинки некуда ужаться), разделитель визуально стоял
  на месте. Дыра №2: захват высоты был одноразовый — нода, скрытая в
  момент монта (offsetHeight 0), не давала зеркалу высоту никогда.
- ФИКСЫ: (1) isFlexSplitRoot — предикат «самоуложившаяся сплит-панель»
  (computed flex + column + собственный ns/row-resize грип среди потомков;
  jsdom видит инлайн-стили, браузер — стили пака, оба попадают):
  normalizeGhostMedia ПРОПУСКАЕТ такие клоны целиком (ни media-класса, ни
  freeBox — раскладку ведёт СТИЛЬ ПАКА, хабу принадлежит только высота
  корня); (2) setSplitHeight — высота инлайном с !important (каскад:
  автор-important inline > автор-important правила) — устойчиво к ЛЮБЫМ
  будущим правилам CSS зеркал; (3) фолбэк захвата: оригинал не отдаёт
  высоту → берём упакованную высоту свежедобавленного клона (>= 145px:
  картинка 80 + грип 5 + панель >= 60); (4) ResizeObserver на ОРИГИНАЛЕ:
  ресайз ноды теперь ЖИВО ведёт зеркало (высота не одноразовый снимок;
  гвард touch-лока, отсоединение в releaseDom, фолбэк offsetHeight).
- Смоуки: smoke_v33.mjs (24 чека: сплит-клон без media-класса + высота
  inline-important; медиа клона не тронуто; graceful no-op в layoutless;
  фолбэк 210px + персист в item; media-флейвор жив для обычных виджетов;
  flex-без-грипа не переклассифицирован; float-легаси жив; RO —
  обновление, идемпотентность, пауза под touch-локом, изолированность
  записей, дисконнект; сплит-драг с клэмпом и форвардом; release чистит
  зеркала и RO). smoke_v31 F1 переведён на баннер v33.
- Регресс: v32 17, v31 38, v30 35, text_resize 34, presets_v29 78,
  ghost_lock 8, ghost_prefix 8, canvas_route 2, resize_pin,
  media_dl_chrome 29 — ALL PASSED; node --check web/*.js.
- Коммит: «fix(hub): v33 preview split mirrors survive mirror CSS -
  inline-important root height, media-rewrite skip for split panels, live
  node-resize tracking»

### v32: самодостаточные ghost-зеркала — Model Preview Override (KJNodes): инфо-панель НЕ лежит на картинке, живой разделитель в хабе
- РЕПОРТ: превью из Model Preview Override (kj_preview DOM-виджет) в хабе
  рисовалось с инфо-панелью ПОВЕРХ картинки (в ноде картинка и инфо
  разделены перетаскиваемым грипом), и драг разделителя в хабе работал
  неправильно.
- КОРЕНЬ 1 (наложение): универсальная нормализация .hub-portal-ghost
  плющила КАЖДЫЙ корень (position:static + display:block !important).
  kj-pov-root — колонно-flex панель с position:relative зоной картинки и
  absolute-fill <img> внутри: плющение убивало flex-колонку, а картинки
  выпадали из зоны (их containing block становился .hub-portal-host —
  position:relative!) и растягивались на весь host; непрозрачная инфо-
  панель ложилась поверх. РЕШЕНИЕ: жёсткий detach стал OPT-IN — mountDom-
  Portal добавляет .hub-portal-ghost-float ТОЛЬКО корням, которые
  ПОЗИЦИОНИРУЮТ СЕБЯ САМИ (computed absolute/fixed — панели, под которые
  правила писались); мягкая база (width/margin/visibility/pointer-events/
  z-index/top-left-right-bottom auto) сохраняет собственную layout-систему
  источника. Статичные/block-корни не меняются вовсе — риск регрессии
  существующих ghost-панелей нулевой (для них computed = static/block).
- КОРЕНЬ 2 (схлопывание картинки): контентный клон давал image-area
  (flex:1, контент абсолютный) только min-height 80px. РЕШЕНИЕ:
  applyGhostPanelSize — flex-column корням клон получает inline height =
  сплит-высота: при первом монте offsetHeight ОРИГИНАЛА (трансформ-независ.
  — работает и для нод вне вьюпорта; jsdom/layoutless — graceful no-op),
  персистится в item.ghostSplitH (сериализуется с графом как ghostTextHs),
  переприменяется после каждого re-clone swap. Сплит картинка/инфо в хабе
  = 1:1 с нодой; не-flex корни не трогаются (легаси-поведение).
- КОРЕНЬ 3 (разделитель): грип клонa форвардил события в оригинал —
  оригинальный хендлер ресайзил ТОЛЬКО панель ноды, клон догонял через
  отложенные rebuild'ы, а те могли приземлиться середрагом (pointermove НЕ
  продлевал touch-lock — защита умирала через 900мс). РЕШЕНИЕ: (a)
  локальный сплит-драг на клоне (splitDrag: mousedown на элементе с
  computed cursor ns/row-resize, панель = nextElementSibling, клэмп как у
  kj-ноды: панель >= 60px, медиа-зона >= 80px от высоты зеркала) —
  мгновенный отклик в хабе; форвард продолжает крутить оригинал синхронно
  (нода сохраняет свой kjPovPanelH на mouseup), на отпускании rebuild
  выравнивает обе стороны; (b) pointermove/mousemove добавлены в touch-arms
  — лок продлевается весь жест (чинит и ЛЮБЫЕ долгие драги внутри ghost
  зеркал, напр. нативные слайдеры).
- Смоуки: smoke_v32.mjs (17 чек: мягкий базис + ghostSplitH + graceful
  no-op, float opt-in, локальный драг с клэмпом и живым форвардом,
  продление лока pointermove — без него rebuild на ~980мс, переживание
  высоты после rebuild, release). smoke_v31 F1 переведён на баннер v32.
- Регресс: v31 38, v30 35, text_resize 34, presets_v29 78, ghost_lock 8,
  ghost_prefix 8, canvas_route 2, resize_pin, media_dl_chrome 29 — ALL
  PASSED; node --check web/*.js.
- Коммит: «fix(hub): v32 self-laid-out ghost mirrors - KJNodes Model
  Preview Override keeps its image/info split, live local grip drag in
  the hub».
### v31: шесть полевых фиксов — ширина значений, честный коллапс, одиночный unpin, 👁 против ✕ вкладки, уход закреплённого хаба при смене воркфлоу, колесо-слайдер
- РЕПОРТ 1 «значения слишком ограничены по ширине»: label был flex:1
  (заголовок съедал всю ширину), зеркала жёстко кэпились (input 100px,
  combo 110px, range 78px) — при ресайзе хаба (нода или pin-окно) рос только
  заголовок. СЕТКА: .hub-item-label — контентная ширина (min 56px, максимум
  45%); зеркала combo/media/num/single-line text получили hub-mirror-grow
  (flex:1 1 120px, min-width:0) и тянутся в свободную ширину; range —
  flex:1 1 78px внутри числовой пары; текстовое поле — width:100% в
  обёртке; combo-триггер — width:100% (кэп снят, label эллипсится). Тулзы
  обёрнуты в .hub-row-tools (margin-left:auto) — правый край ряда на ЛЮБОЙ
  его форме (checkbox/button-ряды без растяжения раньше «висели» в
  середине). Мультилайн и чекбоксы не тронуты.
- РЕПОРТ 2 «свернуть прячет контент, а не окно»: при hub-pin-sized инлайн
  ширина/высота оставались — за шапкой оставалась пустая оболочка.
  Свернуть = СЖАТЬ ОКНО: applyPinSize игнорирует сохранённый размер, пока
  cfg.pinMin (инлайн-бокс сброшен; CSS .hub-pin-collapsed width/height:
  auto !important + min-width:150px), при развороте размер возвращается из
  cfg; глиф «-»/«+»; свёрнутое состояние переживает re-render.
- РЕПОРТ 3 «2 unpin»: в плавающем окне дублировались pin-кнопка шапки и
  pin-кнопка таб-бара. Пока хаб плавает, таб-баровский твин скрыт
  (.hub-pin-body .hub-tab-bar .hub-pin-toggle display:none); на канве
  таб-баровский pin остаётся способом запинить.
- РЕПОРТ 4 «eye должен прятать и крестик вкладки»: в список chrome-hidden
  добавлен .hub-tab-del; тайтл тоггла перечисляет tab x.
- РЕПОРТ 5 «пин-хаб не исчезает при переключении воркфлоу»: configure()
  пересобирает инстансы нод и НЕ ОБЯЗАН звать onRemoved — панель и запись
  реестра переживали смену воркфлоу. hub_ui_renderer.pruneForeignHubs():
  хаб, недостижимый из живого корневого графа (обход allGraphs; СБОЙ обхода
  = «живой», состояние не рушим), забывается (forgetHubNode) и теряет
  визуал (disposeHubVisuals); вызов в hub_node.afterConfigureGraph ДО
  syncAll-перерисовки выживших. Вернувшийся воркфлоу рефлоатит свежий
  инстанс по сохранённым pinPos/pinSize.
- РЕПОРТ 6 «крутить слайдер колесом»: wheel по .hub-mirror-num (кроме поля
  числа) крутит значение: +/-step, Shift = x10; Ctrl+wheel не перехватывается
  (зум браузера); preventDefault гасит скролл контейнера. Значение идёт тем
  же пайплайном, что драг: coerceNumeric (границы + override'ы + сетка
  шага), синтетическое окно растёт односторонне в pushControlToTarget,
  number-сиблинг синхронизируется. Подсказка в тайтлах обоих вариантов
  range.
- Смоуки: smoke_v31.mjs (38 чек: A коллапс окна, B CSS/DOM-контракты unpin/
  вкладки, D wheel, E layout-контракт, C prune при смене воркфлоу, F
  баннер); smoke_ghost_prefix.mjs переведён с оригинальной upload-копии на
  ТЕКУЩИЙ portal_manager (тестировал файл из upload/, отставший на 30
  версий, и падал ложно) + стаб findWidgetOnNode — 8/8.
- Регресс: v30 35, text_resize 34, presets_v29 78, ghost_lock 8,
  canvas_route 2, resize_pin, media_dl_chrome 29, ghost_prefix 8 —
  ALL PASSED; node --check web/*.js.
- Коммит: «fix(hub): v31 field batch - stretched value mirrors, real window
  collapse, single unpin, tab-x chrome, workflow-switch prune, wheel
  sliders».

### v30.3: классические (всегда видимые) скроллбары зеркал + верификация сборки
- ПОЛЕВОЙ РЕПОРТ (скриншоты 6/7 строк): бокс фиксирован (v30.2 работает —
  высота поля ОДИНАКОВАЯ на обоих скриншотах ~155px), но на первой же
  переполняющей строке скроллбар НЕВИДИМ, а нативный грип ИСЧЕЗАЕТ; строка
  «1» обрезана сверху — поле уехало скроллом под каретку.
- КОРЕНЬ: Windows 11 Chrome и Electron (ComfyUI Desktop) рисуют fluent
  OVERLAY-скроллбары — они автопрячутся в покое, и вместе с ними из угла
  пропадает нативный ресайз-грип (угол принадлежит слою скроллбара).
  Headless-Linux это не воспроизводит (грип есть во всех режимах) —
  лечим документированными выходами из overlay-режима.
- РЕШЕНИЕ (styles.css .hub-text-area): кастомные ::-webkit-scrollbar
  (width 9, thumb #3d4358, hover #565d78) — выводит элемент из fluent-
  пайплайна в классический (полоса + живой угол); стандартный фолбэк
  scrollbar-width: thin + scrollbar-color (thin НИКОГДА не рисуется как
  автопрячущееся overlay). overflow-y остаётся auto (полоса только при
  переполнении).
- ВЕРИФИКАЦИЯ СБОРКИ: settings_hub.js печатает в консоль баннер
  «[SettingsHub] web build: v30.3 …» — «новый файл вообще загрузился?»
  больше не гадание (усталость от двух раундов «не помогло»).
- ДИАГНОСТИКА: Alt+клик по чипу ⤢ не тогглит, а печатает в консоль правду
  бокса зеркала (inlineH/clientH/scrollH/scrollTop/overflowY/resize/
  fieldSizing/scrollbarWidth) — следующие полевые репорты приходят с данными.
- Смоки: ZQ +B7 (CSS-контракт выхода из overlay) и +B8 (баннер) — 35 чек.
- Коммит: «fix(hub): force classic always-visible scrollbars on mirrors -
  fluent overlay ate the thumb and the resize grip (Win11/Electron)».

### v30.2: управляемые высоты multiline-зеркал (грип + скроллбар)
- ПОЛЕВОЙ РЕПОРТ: конвертация ⤢ в single-line работает, но маркер ресайза
  по-прежнему уезжает с числом строк, а скроллбар не появляется, когда
  строки не влезают. Причина: v30.1 держал высоту чисто в CSS
  (field-sizing:fixed + max-height + overflow-y) — в реальном фронтенде это
  не устояло (его глобальные textarea-стили эпохи field-sizing:content
  снова вытянули бокс по контенту; нельзя исключать и кэш styles.css —
  опираться на CSS-констрейнты больше нельзя в принципе).
- РЕШЕНИЕ: высота зеркала УПРАВЛЯЕТСЯ ИЗ JS — applyManagedTextHeights
  (бывшая applySavedTextHeights) при КАЖДОМ renderHub выставляет явный
  inline px на каждую textarea.hub-text-area: сохранённая пользователем
  item.textH (позиция грипа, переживает re-render и сериализацию) либо
  TEXT_MIRROR_H=64 («3 строки» по умолчанию). Явный inline height старше
  field-sizing:content в любом браузере — рамка фиксирована
  детерминированно: скроллбар появляется ровно когда строки не влезают,
  грип всегда в том же достижимом углу. CSS-кэп v30.1 (max-height 180 +
  правило [style*=height]) удалён как мёртвый; overflow-y:auto !important
  оставлен страховкой.
- ГРИП: pointerup/mouseup сохраняет натянутую высоту в item.textH (механика
  v27.4, не изменилась); дефолт 64 тоже inline — случайный клик по полю не
  меняет ничего (значение равно дефолту).
- Призраки (порталы) не тронуты: их высоты живут в item.ghostTextHs и
  следуют за родным виджетом фронтенда.
- Карта: hub_ui_renderer.js +TEXT_MIRROR_H/applyManagedTextHeights;
  styles.css .hub-text-area — комментарий-контракт, max-height снят.
- Коммит: «fix(hub): JS-managed mirror heights - fixed textarea frame with
  scrollbar and always-reachable grip».

### v30.1: полевые фиксы media/multiline/чипов
- МЕДИА-ДЕТЕКТ усилен (репорт: у Load Image не было 🎬-пункта, только
  viewer): сигналы лоадера = флаги на combo (как раньше) ИЛИ ЛЮБОЙ из
  {собственные onDragOver+onDrop instance-пропсы, upload-кнопка (имя
  /upload/i, с callback), node.pasteFiles (классические сборки)} при
  media-имени combo; 🎬-пункт в меню теперь ПЕРЕД «🖼 Pin viewer» (на
  Load Image viewer-подменю прятал медиа-пункт внизу).
- MULTILINE: ручной выбор ⤢ (options.mlManual) ФИКСИРУЕТ форму зеркала —
  live-пере-детект (значение с \n, смонтированная textarea) больше не
  побеждает чип (раньше поле с многострочным значением нельзя было
  вернуть в однострочный input — «кнопка никак не отражается»).
  .hub-text-area: field-sizing:fixed !important (фронтендовые глобальные
  стили с field-sizing:content заставляли бокс расти с числом строк и
  уводили грип за пределы видимости) + max-height 180px + внутренний
  overflow-y:auto (скроллбар по запросу); сохранённая/натянутая
  пользователем высота (inline style) снимает кэп правилом
  [style*="height"] { max-height: none }.
- ПОРЯДОК ТУЛЗОВ В СТРОКЕ: ⚙ слайдера ПЕРВЫМ, затем 💾 include-in-presets
  (рядом с 🎯), затем ⤢ — убрана «лесенка» на слайдерных строках.
- Коммит: «fix(hub): field polish - media detect signals, multiline manual
  shape pin with capped scrolling textarea, row tool order».

### v30: media-source row, same-name widget ordinals, multiline chip
- ORDINALS (фикс Fast Groups Bypasser/Muter от rgthree): пак регистрирует
  КАЖДУЮ строку-тоггл отдельным виджетом с ОДНИМ именем
  «RGTHREE_TOGGLE_AND_NAV» — поиск по имени всегда возвращал ПЕРВУЮ строку,
  поэтому панельный пин рисовал первый тоггл N раз (репорт: «первый элемент
  дублируется столько, сколько элементов»). core.findWidgetOnNode(tn, name,
  ord) — резолв по имени + порядковому номеру среди одноимённых; пин хранит
  item.widgetOrd / members[].ord (0 у уникальных имён); ВСЕ резолвы
  (sync_manager-хуки, порталы single+members, findTarget рендерера,
  slider-overrides core, пресеты) идут через него; выход за диапазон
  деградирует к первой строке (строки удаляются/пересортируются пакетом).
- MULTILINE (фикс «Text (Multiline) — нет грипа»): isMultilineWidget
  усилен — truthy-флаги («true»/1), TEXT-значение с переводом строки,
  подсказка «multiline» в name/label (флаг часто живёт только в DEF ноды и
  не доходит до объекта виджета). Гарантированный путь: чип ⤢ на каждой
  TEXT-строке (авторский чром, прячется 👁) переключает input ↔ растущую
  textarea с грипом (item.options.multiline) и помечает выбор mlManual=true
  — ручной выбор ВЫИГРЫВАЕТ у авто-хила renderHub (раньше тот затирал флаг
  на каждом рендере).
- CRLF-АУДИТ: viewer_gallery / global_settings / dnd_manager / sync /
  settings_hub .js оказались LF (созданы генерацией) — нормализованы к CRLF.
- MEDIA-SOURCE ROW: ПКМ по ноде-лоадеру (LoadImage/LoadVideo/LoadAudio +
  кастомы) → «🎬 Pin media source (preview + upload)» — ОДНА строка:
  [превью input-файла 40px] [поисковый file-combo] [📁].
  ДЕТЕКТ core.mediaLoaderInfo: combo с media-флагами (image_upload /
  video_upload / audio_upload / animated_image_upload — те же, на которых
  стоит upload-расширение фронтенда); фолбэк — у ноды СВОИ instance-пропсы
  onDragOver+onDrop (ставят upload-композаблы) + media-имя у combo.
  createMediaBinding: widgetType «media», options.media {kind, folder};
  само-хил renderHeader ИСКЛЮЧАЕТ media-строки (иначе вылечил бы строку в
  обычный combo и снёс превью/загрузку).
  ПРЕВЬЮ: viewer_gallery.firstMediaSpec читает output store — фронтенд
  держит там input-файлы лоадеров (type:"input"); пустой стор → фолбэк
  /view?filename=<combo>&type=<folder>; img / video (muted, preload=
  metadata) / иконка+имя для audio; guard srcSig (URL не изменился — DOM
  не трогаем); отрисовка на renderHub и в refreshValuesDom (реактивно,
  без поллинга).
  ЗАГРУЗКА: 📁 → СНАЧАЛА родная upload-кнопка ноды (имя /upload/i) — её
  пикер/accept/batch остаются авторитетными; иначе скрытый file input.
  Файлы идут через uploadMediaFiles: маршрут A — синтезированный
  DragEvent+DataTransfer в onDrop НОДЫ (весь её пайплайн: фильтр,
  /upload/image, обновление combo, batch — кастомные паки ведут себя
  1:1); маршрут B (нет onDrop/DragEvent) — прямой POST /upload/image
  (type=folder) → путь → pushComboValue (tw.options.values + item) →
  writeTargetValue; отчёт тостом. Дроп-зона = весь media-миррор
  (stopPropagation против канвасного дропа). Пресеты: media-строки
  захватываются как combo-значения (применение восстанавливает выбранный
  файл). Триггер combo в строке — стандартный data-role="combo": поиск,
  тултипы, рефреш достаются бесплатно.
- Карта (дополнения): core.js +mediaLoaderInfo/createMediaBinding/
  findWidgetOnNode; viewer_gallery.js +firstMediaSpec; context_menu.js
  +🎬-пункт и buildMediaSubmenu; hub_ui_renderer.js +media-миррор,
  paintMediaPreview/uploadMediaFiles, ⤢-чип; styles.css +.hub-media-*.
- Коммиты: «fix(hub): same-name widget ordinals - rgthree Fast Groups rows
  no longer duplicate the first toggle»; «feat(hub): media-source rows -
  input preview, searchable combo, upload via the node's own pipeline»;
  «fix(hub): multiline detection hardening + per-row multiline toggle chip».

### v29: Presets UX — чип opt-out, пикер с поиском, quick-save + merge, diff-поповер, тосты
- ОПТ-АУТ = ЧИП: на строках value-байндингов кнопка .hub-inpreset (глиф 💾,
  класс hub-btn) вместо чекбокса — на bool-строках чекбокс читался как
  второе значение. Участвует = тихий чип; исключено (.hub-inpreset-off) =
  приглушено + диагональный штрих (::after), tooltip меняется. Клик — case
  "inpreset-toggle" в click-делегировании: флаг item.inPreset ставится/
  удаляется ТОЧЕЧНО (без renderHub), syncNode + setDirtyCanvas. Чип —
  авторский чром (правило .hub-chrome-hidden прежнее).
- ПИКЕР (замена <select>): триггер .hub-preset-trigger (метка «Preset…»
  либо ⏱ последний применённый пресет СЕССИИ из stateMap.lastPresetName —
  НЕ в cfg; бейдж = число пресетов АКТИВНОЙ вкладки) открывает body-level
  .hub-preset-picker (паттерн combo-поиска, свои global-листенеры
  mousedown/Escape, positionNumPopup). Список: секция «This tab · <имя>»
  (scope === активная вкладка; избранные первыми — СТАБИЛЬНАЯ сортировка
  favFirst, порядок вставки сохраняется) + свёрнутая приглушённая секция
  «Other tabs (N)» (клик по заголовку раскрывает; чужой пресет применить
  можно — строки те же). Поиск (инпут .hub-combo-search, автфокус):
  мульти-токены AND, case-insensitive, comboTokensMatch по имени И
  label/value записей (presetMatchesQuery); НЕпустой запрос ищет по ВСЕМ
  вкладкам и раскрывает чужую секцию; ↑/↓ двигают активную строку
  (.hub-pp-active), Enter открывает применение, Esc закрывает. Строки:
  ★/☆ fav (preset.fav), ✏ rename, ⧉ duplicate, 📋 copy JSON в клипборд
  (clipboard API, фолбэк textarea+execCommand), ⤓ export одного пресета
  (wrapped-формат с одним пресетом; Import его читает), 🗑 delete (confirm),
  бейдж «⚠K» = clean dead entries (confirm; модель пикера перестраивается).
  Клик по строке = openPresetApplyPopover (триггер — КНОПКА триггера пикера,
  не строка: строка удаляется вместе с пикером, rect нулевой). ⋯ в ряду
  пресетов = только глобальное: Export all / Import / 💾 Include all rows
  (N) / 💾 Exclude all rows (N) / Cancel (presetBulkOpt: value-байндинги
  активной вкладки, счётчик ИЗМЕНЁННЫХ строк, после — renderHub + тост).
  Кнопки ➕ и 🗑️ из ряда удалены (➕ == 💾; удаление — в строках пикера).
- QUICK-SAVE (замена prompt()): 💾 открывает .hub-qs-pop: имя (авто- «Preset
  N», Enter=Save), живая строка «Will capture N value(s) from tab "X" (K
  row(s) excluded)» — СУХОЙ прогон captureActiveTab (теперь exported:
  запись несёт excluded — сколько чип-исключённых строк было при захвате),
  список существующих пресетов (фильтр comboTokensMatch; бейдж чужой
  вкладки) c кнопками [Merge]/[Overwrite] (overwrite = presetSave с его
  confirm), футер [Save]/[Cancel]. presetSave(node, name) больше НЕ зовёт
  prompt() (пустое имя = no-op); presetNew удалён.
- MERGE-ЗАХВАТ: presetMergeInto(node, name) — снапшот активной вкладки
  вливается в существующий пресет: матч по itemId, иначе по stable-key
  (nodeId+widget) — обновление, иначе добавление; scope/ts/excluded — от
  снапшота (last capture wins). Тост «Merged into "X" - +A added, U updated».
- DIFF-ПОПОВЕР: у ok-строк с дрейфом значение показывается парой «current →
  preset» (.hub-ppr-cur перечёркнут — flex-СИБЛИНГ .hub-ppr-val, не внутри:
  у val max-width 110px; класс строки .hub-ppr-drift); «Only changed» в
  футере — фильтр ВИДА (прячет строки без дрейфа через
  .hub-ppr-list.hub-ppr-onlychg; Apply по-прежнему пишет все отмеченные —
  неизменившиеся записи безвредны, подсказка в поповере оговаривает).
- ТОСТ: после Apply поповер ЗАКРЫВАЕТСЯ, внизу по центру body-level
  .hub-toast «Applied N of M (K skipped) · "Name"» c [↩ Undo] (6с,
  авто-скрытие, единственный инстанс showHubToast/hideHubToast; esc()).
  Undo = presetUndo + refreshPresetRowInPlace (ряд пресетов
  перерисовывается точечно — ↩ исчезает, метка триггера обновляется).
  Тосты также для save/merge/bulk. ↩ в ряду пресетов остаётся.
- ФОРМАТ: cfg.presets[name] = { v:2, ts, scope, excluded?, fav?, entries[] }
  — оба новых поля опциональны, обратно совместимы.
- Пресет-ряд: [picker-триггер] [💾] [↩?] [⋯] [＋Div] [⚙].

### v25: фильтр виджетов, скрытие хрома, тихое удаление, очистка очереди
- 🔍 фильтр (вход в таб-баре, свёрнут до линзы, :focus/.hub-search-active
  расширяет): подстрока по customLabel/widgetToBind/делителям АКТИВНОЙ
  вкладки, case-insensitive. БЕЗ innerHTML на каждый кейс — класс
  .hub-row-hidden на строки (фокус при печати живёт); запрос — сессионный
  (stateMap.searchQuery, НЕ в cfg), renderHub восстанавливает значение и
  пере-применяет фильтр; Esc очищает; заметка .hub-search-empty на ноль
  совпадений. Во время поиска .hub-searching прячет drag-ручки
  (реордер среди скрытых строк корраптил бы порядок).
- 👁 chrome-toggle в таб-баре: cfg.hideChrome (нормализация в
  getHubConfig, переживает сериализацию) → класс .hub-chrome-hidden на
  .settings-hub; CSS прячет .hub-drag-handle и .hub-remove (двигается и
  удаляется только через видимый чром).
- Удаление из хаба (case "unpin", делители тоже) — БЕЗ confirm(): один
  клик по ✕, параметр остаётся на ноде, откат = повторный пин из меню.
- 🗑 рядом с ▶ Queue: теперь «очистить ВСЮ очередь», всегда кликабельна:
  interrupt текущей задачи (api.interrupt → POST /interrupt) + wipe
  ожидающих (api.clearQueue → POST /queue {"clear":true} — родной payload
  Clear). Класс .hub-interrupt-on — чисто визуальная подсказка «есть что
  чистить» (disabled больше не используется); badge и ▶-live живут как в
  v24; после очистки оптимистичный сброс running/remaining (сервер
  пересинхронизирует событиями).

### v26: глобальные настройки (⚙) и пин вьюверов
- ⚙ в строке пресетов открывает .hub-set-pop (тот же body-level паттерн,
  что combo/num попапы; toggle-повторный клик, Esc/клик-вне закрывают).
  Единственная настройка — «Mirror update rate»: 0 (Events only, дефолт)
  / 100 / 250 / 500 / 1000 / 2000 мс. Состояние — в global_settings.js
  (REFRESH_CHOICES, getRefreshMs/setRefreshMs, refreshLabel), персист в
  localStorage (ключ settingshub.refreshMs) — это ПРЕДПОЧТЕНИЕ
  пользователя, НЕ состояние воркфлоу (не в node.properties).
- Зачем: реактивный движок ловит только изменения через callback виджета;
  onExecuted-патчи, прямые присваивания widget.value в коде нод и бекенд
  значения событий НЕ дают — зеркала ждали структурного ре-рендера. Поллер
  (setInterval → refreshNodeValues по всем хабам, value-only БЕЗ innerHTML,
  document.hidden гвардия) догоняет такие значения на выбранной скорости.
- ⚙ получает класс .hub-settings-on, когда поллер активен (и после
  ре-рендера тоже — рендер-хвост синхронизирует с getRefreshMs()).
- Инвариант «БЕЗ поллинга» не сломан: дефолт 0 = ноль фоновой активности;
  поллер — явный opt-in пользователя.
- Вьюверы (🖼): классические PreviewImage/LoadImage/SaveImage и многие
  кастомные ноды рисуют картинку/видео прямо в node.onDrawBackground —
  виджета НЕТ, виджет-пин невозможен. Новое NODE-уровневое встраивание:
  isViewerNode(n) (гейт onDrawBackground + (media-поля ИЛИ имя ноды по
  /preview|viewer|image|video|media|combine|show/i)); пункт «🖼 Pin viewer
  (live embed)» в меню ноды + в Ctrl/Cmd+ПКМ override + в DOM-surface меню.
- createViewerBinding: item type widget_portal, options.viewer=true,
  widgetToBind=__viewer__ (VIEWER_SENTINEL), targetTitle — drift-якорь.
  mountViewerPortal скармливает mountCanvasPortal псевдо-виджет, чей draw()
  вызывает tn.onDrawBackground(ctx) — поверхность портала = начало ноды;
  pixel-settle цикл подгоняет высоту. Read-only (форвардинг мыши выключен).
- Тег 🖼 live отличает вьювер-строки от панельных (🪟 live); keepPortalTag
  тепер СОХРАНЯЕТ тег при монтировании портала (прежде host.textContent=""
  стирал его мгновенно) — тег живёт над встраиванием.
- Orphan-гигиена: itemRowHtml и refreshValuesDom считают viewer-строку
  живой, если резолвится НОДА (tw не требуется); reportUnresolved для
  viewer печатает «(whole node embed)» вместо внутреннего sentinel.

### v26.2: SELF-RENDERED вьюверы (свой плеер вместо зеркала)
- ПОЛЕВЫЕ СИМПТОМЫ v26.1 (гост-зеркало «$$canvas-image-preview»): картинки
  НЕ видны вообще (фронтенд РИСУЕТ превью на canvas — cloneNode копирует
  элемент, но не битовую карту → пустой холст); видео мерцает каждый кадр
  и показывает только первые кадры (rebuild-цикл госта пересоздавал <video>,
  а timeupdate-синк currentTime дрался с его же воспроизведением); строки/
  нода мелко дёргали размером (тот же churn).
- Решение (предложено пользователем): НЕ перехватывать виджет — хаб строит
  СВОЙ медиа-элемент и кормит его от живого превью источника:
  * video → собственный нативный <video controls loop muted autoplay
    playsinline> — НАСТОЯЩИЙ плеер: перемотка/пауза/звук; src копируется
    (blob:-URL валиден в том же документе);
  * img   → собственный <img> с живым src;
  * canvas → блит в собственный <canvas> лёгким интервалом 120 мс
    (document.hidden гвардия, размер = размеру исходной битовой карты);
  * ничего из перечисленного → прежний painter-портал (onDrawBackground +
    фолбэк node.imgs из v26.1).
- portal_manager.js: findSourceMedia (video > img > canvas ≥2px; возвращает
  widget+container+media+kind), liveMediaSrc (currentSrc/src/attr/<source>),
  mountMediaViewer (+keepPortalTag; rec.kind="viewer", rec.release).
  Вотчер: MutationObserver контейнера источника (childList+subtree+
  attributeFilter:["src"]) + страховочный setInterval 1 с; apply()
  РЕ-РЕШАЕТ живой media-элемент при каждом проходе (Vue перемонтирует
  превью между запусками) и переприсваивает src ТОЛЬКО при реальной
  смене (rec.lastSrc) — новая генерация подхватывается сама.
- releaseRecord ветвит kind="viewer" → rec.release (стоп таймеров,
  disconnect, pause, remove). Источник ТОЛЬКО читается — никогда не
  клонируется и не стилизуется: ни мерцания, ни дёрганья размеров.
- styles.css: .hub-viewer-media (width:100%, height:auto — аспект из
  интринсик-размеров; фон .hub-viewer-media #101020).
- normalizeGhostMedia остаётся для ОБЫЧНЫХ custom-panel гостей (обрезка
  видео в панелях); для viewer-маунтов гости больше не используются.
- Smoke Phase ZJ (обновлена, +25): «$$»-фильтр, isViewerNode-матрица,
  end-to-end video → СВОЙ <video controls> (controls/loop/muted, src
  скопирован, госта нет), вотчер подхватывает смену src (blob:x→blob:y),
  img-маршрут, canvas-блит (размер 320 принят), тихий ✕. Грабль: id
  тестовой ноды 69004 совпал с авто-id хаба фазы → resolve брал хаб
  ( FakeLGraphNode конструктор рандомит id; createNewHub через graph.add
  ставит max+1) — ручные id в фазах выбирать вне диапазона auto. Стенд:
  play/pause заглушены на HTMLMediaElement (jsdom «Not implemented» шум).
  База >=655.

### v26.1: боевые правки вьюверов и внутренних виджетов ($$)
- ПОЛЕВЫЕ СИМПТОМЫ: (1) «Pin viewer» в новом фронтенде вечно рисует «🖼
  waiting for the source preview» — размер подстраивается, контента нет;
  (2) обычный пин из SaveImage биндит ТЕКСТОВОЕ поле «$$canvas-image-
  preview»; (3) Video Combine в «Pin custom panel» показывает видео,
  ОБРЕЗАННОЕ по высоте.
- Причина: новый фронтенд рендерит превью НЕ в onDrawBackground, а в
  СКРЫТОМ DOM-виджете «$$canvas-image-preview» (контейнер с img/video/
  canvas внутри). Пейинтера нет → blank-режим → вечный hint. А сам этот
  виджет классифицировался как portal/text и попадал в меню пина.
- core.js: isInternalWidget(w) — имя начинается с «$$» = служебный виджет
  фронтенда, НЕ пиннится никогда; findNodeMediaWidget(node) — первый
  виджет, чей element (или сам element) есть IMG/VIDEO/CANVAS.
  isViewerNode ослаблен: достаточно painter ИЛИ DOM-медиа-виджета (квалификация
  прежняя: media-поля ИЛИ имя ИЛИ медиа-виджет).
- context_menu.js: «$$» вырезан из path-1 (виджет под курсором) и из
  listPanelWidgets; на DOM-поверхностях, принадлежащих «$$»-виджету,
  предлагается ТОЛЬКО viewer-пин (entriesForInternalOwner) — ПКМ прямо по
  превью = «🖼 Pin viewer», а не текстовое зеркало.
- portal_manager.js, mountPortals (viewer-ветка): ПРИОРИТЕТ — DOM-медиа
  виджет: mountDomPortal(item, mw, host, {viewer:true}) — ЖИВОЕ зеркало
  img/video (клоны держат src, MutationObserver ловит смену превью).
  Фолбэк — прежний painter-портал.
- Новое в mountDomPortal: normalizeGhostMedia — медиа в госте
  аспект-корректится (width:100%, height:auto, object-fit:contain),
  node-baked инлайн-высоты госта/обёрток сбрасываются в auto; класс
  hub-portal-media (+CSS-дубли в styles.css с !important — на случай
  восстановления инлайнов при ребилде). Для viewer-маунтов нормализуются
  и canvas (в панелях canvas = функциональный UI, не трогаем). Это же
  чинит обрезку видео в «Pin custom panel» (там viewer=false, но media
  img/video нормализуются так же). syncViewerVideos: timeupdate источника
  → currentTime клона (зеркало не застывает на первом кадре);
  syncViewerVideoTime при каждом ребилде; unsync в releaseDom.
- Painter-портал (классика): rec.altPainters — фолбэк-пейинтеры,
  опрашиваемые когда стэк рисует пустоту: drawViewerImgs рисует последний
  node.imgs letterbox'ом, при пустом imgs loadViewerSpecs лениво грузит
  specs (filename/subfolder/type → /view?...) в tn.imgs. Режимы:
  mode="alt" + altWinner (стабильная фаза), altSig/altIdx — ретраи при
  смене media-состояния (превью появилась ПОСЛЕ пина → подхватится).
  Hint «waiting» теперь честно только когда нет НИ стека, НИ imgs.
- Smoke: Phase ZJ (+23) — фильтр «$$» (path-1/панель-список),
  isInternalWidget/findNodeMediaWidget, isViewerNode-матрица (media-виджет
  без пейнтера=true; именованная панель с img=false), end-to-end:
  video-вьювер монтирует DOM-гост (не canvas), классы/стили нормализации,
  тег «🖼 live» выживает, img-нода тем же маршрутом, тихий ✕. База >=653.

### v27: галерея-вьювер из выходного стора + глобальный звук видео
- ПОЛЕВОЙ СИМПТОМ: «🖼 waiting for the source preview» навсегда для
  PreviewImage/SaveImage. Причина (по исходникам фронта): они рендерят
  превью СЛУЖЕБНЫМ CANVAS-ВИДЖЕТОМ «$$canvas-image-preview»
  (canvasImagePreviewTypes.CANVAS_IMAGE_PREVIEW_WIDGET; BaseWidget
  canvasOnly:true) — у виджета НЕТ element/inputEl/contentEl, DOM-медиа
  нет ВООБЩЕ. findSourceMedia молчит; painter-маршрут не рисует (в новом
  фронте onDrawBackground — это только шим updatePreviews, ставится
  litegraphService.addDrawBackgroundHandler на КАЖДЫЙ класс нод и НЕ
  красит); alt-painter по node.imgs — гонка декодирования (сигнатура
  altSig меняется ДО загрузки картинок, исчерпанная война пробов
  замораживала hint навсегда).
- РЕШЕНИЕ — живой источник №1, хранилище выходов фронтенда:
  viewer_gallery.findOutputImages(tn) строит ПОЛНЫЙ батч URL:
  app.nodeOutputs[locator].images (spec→/view?filename&subfolder&type,
  зеркалит buildImageUrls; api.apiURL учитывает desktop-origin) →
  app.nodePreviewImages[locator] (живые preview-кадры) → легаси
  node.images → src из node.imgs. locatorId: String(node.id) плюс
  суффикс-скан «:id» для сабграфов. Видео/аудио-расширения фильтруются
  (и в путях, и в filename /view) — их путь это <video>-маршрут.
- Маршруты mountPortals (viewer-ветка): DOM video → DOM img →
  ГАЛЕРЕЯ (store) → DOM canvas blit → painter (hint).
- Галерея строки: stage с <img> + ховер-кнопки ◀/▶, счётчик «i / N»,
  ⛶; лента миниатюр (только для батчей, активная подсвечена,
  scrollIntoView); клик по картинке = фуллскрин; колесо = навигация.
  Состояние индекса — сессионный Map по item.id (переживает
  структурные ре-рендеры; НЕ в сериализуемом конфиге). Смена батча
  (сигнатура length|first|mid|last) → idx=0, перезапуск миниатюр,
  синхронизация открытого фуллскрина. Прелоад соседей.
- Фуллскрин — СИНГЛТОН на document.body (.hub-fs-overlay, fixed,
  z-index 2147483000 — инвариант №7): requestFullscreen на оверлей
  (отказ → обычный fixed-щит), fullscreenchange-выход закрывает,
  ←/→/Home/End/Esc (capture), колесо, клик по фону = закрыть.
  closeGalleryFullscreen идемпотентен; releaseRecord/viewer-release
  закрывают оверлей (не осиротевший UI при анпине).
- ИСПРАВЛЕНИЕ alt-painter (painter-маршрут): при исчерпанных пробах
  реарм altIdx каждые 3с (altLastRetry) — поздняя загрузка картинок
  больше не вечный «waiting».
- v27 ЗВУК ВИДЕО — глобально: global_settings.getVideoAudio /
  setVideoAudio / applyVideoAudio (localStorage settingshub.videoMuted
  «1»/«0», settingshub.videoVolume 0..1; дефолт muted+vol=1 —
  autoplay-политика). mountMediaViewer(video): на монтировании и при
  смене src — applyVideoAudio(el) (жёсткое el.muted=true УДАЛЕН);
  volumechange от нативных контролов пишется обратно в глобал
  (persistAudio; same-value эхо от applyVideoAudio безвредно).
  Грабль: Number(null)===0 — отсутствие ключа в localStorage НЕ должно
  зажимать дефолт громкости (гвард raw===null||"").
- Грабль харнеса: jsdom document.hidden===true (prerender) — вотчер
  галереи НЕ гардуется по document.hidden (контракт видео-вотчера
  v26.2); гард остаётся только у canvas-blit.
### Резолвер целей v24 (крест-граф, вложенные сабграфы)
- allGraphs: BFS по УРОВНЯМ (глубина — уровни иерархии, дефолт 12), списки
  нод = union `_nodes` + публичный `nodes`; реестры `_subgraphs`/`subgraphs`/
  `subgraphsById` читаются как Array / Map|Set / объект-словарь; ПЛЮС
  duck-typing сбор: любой OWN ключ ноды, чьё значение похоже на LGraph
  (имеет массив `_nodes`/`nodes`) — считается дочерним холстом (имена
  полей холдеров больше не критичны); дедуп по identity (циклы безопасны).
- findNodeByIdEverywhere: точное `n.id === id` имеет ПРИОРИТЕТ на всём
  пространстве; loose-проход `String(n.id)===String(id)` — только фолбэк
  (поглощает ремапы в строки; не даёт мусорным совпадениям затирать точные).
- resolveBindingTarget: как раньше (id → targetTitle+widget), добавлены
  lastResolverStats() и console.info-хлебный крош reportUnresolved
  (дескриптор пина + сколько графов/нод сканировано) — для
  воспроизводимых полевых багрепортов. v36: репорт ОТЛОЖЕН (~2.5с,
  re-check resolveBindingTarget по item, diagPending WeakSet): рендер хаба
  во время graph.configure не создаёт ложных «pin unresolved» — бредкрамб
  получает только пин, ВСЁ ЕЩЁ неразрешённый после загрузки, со свежей
  статистикой скана; diagReported давит дубли.
- findHolderChainOf ходит по ТЕМ ЖЕ шейпам (locate видит всё, что видит
  резолвер); графы из реестров без холдера получают chain без ступени.

### Locate (🎯) — прыжок внутрь сабграфа
- Порядок: `resolveBindingTarget` → владельческий граф из `tn.graph`, а если
  оно не задано (не все фронтенды его пишут) — из хвоста `findHolderChainOf`
  (поле НАДЕЖНОСТИ, не источника истины). Если владелец ≠ активный граф —
  сначала ВХОД, потом centerOnNode; иначе камера крутит НЕ ТОТ холст.
- Лестница входа `enterOwnerGraph`: прямые сеттеры setGraph/openGraph/
  openSubgraph/showSubgraph → реплей жеста по цепочке холдеров:
  processNodeDoubleClicked → синтетический dblclick через мир->экран.
  Каждая стратегия проверяется фактом смены canvas.graph. Гонки гасятся
  locateSeq: свежий клик перебивает старый (superseded).
- Провал входа — НЕ краш: остаётся highlight/центр как раньше (ZB4).

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
9. DOM-порталы — только GHOST-зеркала: перемещение relocate элемента в хаб
   ЗАПРЕЩЕНО (раньше крало панель у ноды и ломалось о remount-циклы
   ComfyUI). Синхронизация двусторонняя и событийная: (a) клон→оригинал —
   те же типы Event диспетчатся на counterpart по index-path, value/checked
   копируются свойствами ДО dispatch (без echo — observer смотрит ТОЛЬКО
   оригинал); (b) оригинал→клон — debounce 180мс полный re-clone swap;
   ребилд ОТКЛАДЫВАЕТСЯ пока фокус внутри зеркала или <900мс с последнего
   касания (pointerdown/pointermove/mousemove/wheel/key/focusin); занятая
   цепочка перезаказывается по 400мс, не теряется. contextmenu НЕ
   форвардится. v32: ghost-база НЕ плющит layout зеркала — position/
   display/transform снимаются только классом .hub-portal-ghost-float
   (mountDomPortal вешает его на computed absolute/fixed корни);
   flex-column корням высоту задаёт ghostSplitH; сплит-драг резолвится
   УНИВЕРСАЛЬНО (computed cursor ns/row-resize + nextElementSibling),
   хардкод под конкретные ноды запрещён.
10. Липкость relocate-порталов устарела вместе с самим relocate: не двигай
   элементы — проблемы remount-циклов зума/offscreen неприменимы к клону.
11. Поиск хабов — ТОЛЬКО через реестр `allHubs()` (core.js: trackHubNode /
   forgetHubNode): НИКАКИХ обходов одного `graph._nodes`. Хабы всегда живут
   на root (`createNewHub` -> getRootGraph), а пины делают ноды изнутри
   сабграфов — их меню обязано видеть root-хабы. `nodeCreated` трекает,
   `onRemoved` забывает; sync_manager тоже смотрит в реестр (реверберация
   таргет-хуков кросс-графовая). Реестр может быть ХОЛОДНЫМ (кэш-микс
   чанков/рейс загрузки пропустил nodeCreated) — тогда `allHubs()` обязан
   делать live-scan всех достижимых графов, иначе меню теряет существующий
   хаб (полевой инцидент v18).
   ЦЕЛИ ПИНОВ резолвятся только через `resolveBindingTarget` (core.js):
   id по всем графам + фолбэк targetTitle+widgetToBind (renumber после
   перезагрузки). Голый `app.graph.getNodeById` ВНЕ core.js ЗАПРЕЩЁН:
   он невидит сабграфы — пины деградировали в ⚠️-орфанов (полевой
   инцидент «хаб стал пустым после обновления страницы», v18).
12. Числовые зеркала верны источнику: границы/шаг только реальные или
   precision-производные (см. "Числовые зеркала"); свободный набор с точным
   десятичным коммитом — контракт пользователя, не ломать quantize=false.
   ИСКЛЮЧЕНИЕ-дополнение v19, ПЕРЕРАБОТАНО v20: при ОТСУТСТВИИ объявленных
   границ слайдер НЕ опускается — получает АДАПТИВНОЕ окно
   (data-synth-range="1"): первичный рендер центрует ОДИН РАЗ
   (synthSliderWindow), дальше окно управляется growSynthWindow и только
   РАСТЁТ той стороной, куда значение ушло за край. Ре-центровка ЗАПРЕЩЕНА:
   она возвращала ползунок в середину после каждого движения («слайдер
   всегда по центру», полевой инцидент v20) и дёргала шкалу под пальцем.
   Окно ЧИСТО ДИСПЛЕЙНОЕ; во время редактирования контрола (фокус = typing
   ИЛИ drag) эхо-обновления его не трогают вовсе.
   ДОПОЛНЕНИЕ v21: интегральный заявленный шаг НЕ-int источника не запирает
   зеркало на целочисленной сетке — drags/стрелки/эхо используют sliderStep-
   релаксацию (см. "Числовые зеркала"), ручной ввод остаётся свободным.
   Кастомные стены пользователя (sliderOverride) приравнены к объявленным:
   клэмп коммитов по их объединению с исходными границами; проталкивание их
   на реальные виджеты согласовано флагом applySliderOverride (дефолт ON).
13. Создание хаба — ТОЛЬКО каноническое: `LiteGraph.createNode(HUB_NODE_NAME)`
   -> реальный ИНСТАННС -> `graph.add(node)`. Конфиг-объект `{type}` в
   add()/addNode() ЗАПРЕЩЁН: современный LGraph.add дёргает методы ноды
   («TypeError: e.snapToGrid is not a function» — полевой инцидент v18),
   legacy-ветка терпела объект и маскировала баг. Колбэки меню обязаны
   null-guard'ить результат createNewHub — иначе остаётся пустой хаб-осирота.
   Класс регрессий «ReferenceError внутри колбэка меню» закрывается статик-
   линтом фазы Z2: каждый используемый экспорт core.js обязан стоять в
   import-списке модуля (инцидент: getActiveTabId вызывался без импорта).
14. resolveBindingTarget возвращает НАГУЮ НОДУ или null — никогда не пару
   {tn,tw}; потребители ищут виджет сами (tw = tn.widgets.find(...)). Новые
   вызовы обязаны null-check'ить до destructuring (инцидент v21: TypeError
   при orphan-resolve в push-фиче).

## 5. Тесты

Харнес: Node ESM + jsdom (`scripts/smoke_hub.mjs` ВНЕ репозитория), стабы
app.js/LiteGraph, копия реальных `web/*.js` в песочницу. Фазы A–Z покрывают
детекцию типов, зеркала, write-through, пресеты, табы, DnD, multiline,
layout, порталы, whole-panel группы, пиннинг, searchable combo, аутентичную
геометрию/клики порталов (масштаб-компенсация, last_y-стек с гвардом,
клип-рост, анти-схлопывание, pixel-settle высоты и title-less sizing
TrixNodes-класса), DOM-панели (LTX LoRA Stack) как ghost-зеркала:
двусторонняя синхронизация, лок ввода, недеструктивный unpin; Y1 — rename
вкладок кликовым double-detect, Y2 — числовая верность (precision-step,
открытые границы, свободный набор/запятые, echo-гвардия, self-heal),
Y3 — поиск root-хабов из сабграфа + гигиена реестра;
Z1 — канонический путь создания хаба (createNode->add(ИНСТАННС), snapToGrid)
+ отказные ветки (тип не готов, add упал — null, alert, мусора нет);
Z2 — статический линт импортов core.js для всех web/*.js;
Z3 — холодный реестр allHubs: live-scan находит все хабы + дедупликация;
Z4 — кросс-графовые цели: subgraph-пины живые, title-drift repair,
реверб значения из сабграфа в зеркало;
ZB1–ZB4 — locate входит ВЛАДЕЛЬЧЕСКИЙ граф (цепочки холдеров, прямые
сеттеры, реплей двойного клика, отказной деградейшн);
ZB5 — липнущий nudge-слайдер безграничных float'ов: рост одной стороны,
ползунок НЕ приколот к середине (static feel как у KJ), стабильная шкала
в mid-drag; статичный слайдер объявленных границ не изменился.
ZC — слайдер-шаг и кастомные min/max/step: релаксация integral-step>=1 у
float-источников (drags доходят до дробей, decimal-эхо не схлопывается,
int-семейство нетронуто), API override'ов (bare-clear / merge / side-clear /
валидация мусора), статичный рендер с кастомной геометрией + клэмпы typed
коммитов, пушь на реальный виджет, авто-реапплай после симулированного reload
с latch-семантикой и отказным чекбоксом, поповер (open/invalid-keep/clear-side
/close-on-apply), JSON-persistence флага.
ZD — круговорот пушей (v22): native-снапшот до первой записи (min/max/step+
объявленные precision/round) и его НЕПЕРЕЗАПИСЫВАЕМОСТЬ при повторных пушах и
rebuild'ах конфига; step-когерентность (precision 0->2 при step=.25, round:=step
только когда поле объявлено); clearSliderOverride вертает ТОЧНО допушные значения
включая coerced-round; orphan-clear честно reports wiped/restored=false;
плейсхолдеры «·node» из нативов против value=override; фолбэк «·src» без снапшота.
ZE — пиннинг кнопок + очередь (v23): классификация type:"button" (canvas →
"button", DOM-контейнер → portal, мертвые детектятся тоже), биндинг без
options, RUN-зеркало (клик вызывает колбэк источника с this=widget и
value??null, .value не трогается), гиря на строке отсутствует, отсутствие
data-hub-control, изоляция броска хендлера, ok:false на orphan; пресеты
исключают кнопки в снапшоте И в apply (мусорная запись инертна);
самолечение legacy portal-конфига кнопки; queue-бар: дефолт N=1, persist
change'ом, queuePrompt(undefined,N) на клик, спам-клики appending, Enter,
нормализация мусора в 1, клэмп капа 1000, мягкая деградация без
app.queuePrompt, JSON round-trip queueCount.
ZF — v24 (4 фазы): ZF1 резолвер — Map-реестр `_subgraphs`, uuid-холдер БЕЗ
.subgraph, переименованный холдер-ключ `__instanceRef`, публичный `nodes`
вместо `_nodes`, циклический граф, string-id 911090901 + числовой близнец,
title-drift до глубинного листа, статистика скана; ⚠ ids фич-фаз выбирай
ДАЛЕКО за максимумом, который мог наминтить свит (graphAddNode переиспользует
числа после удалений). ZF2 комбо — сплиттер (POSIX/Windows/bare), тултип
закрытого триггера = полный путь, 2×двухстрочные опции c title==dir+base,
короткие остаются плоскими. ZF3 очередь — EventTarget-заглушка app.api,
initQueueStatus идемпотентен, официальный И глубоко-вложенный payload
(строковое число), execution_start → hub-queue-live, Cancel через
api.interrupt() и фолбэк fetchApi('/interrupt',POST), возврат в disabled.
ZF4 пин — panel на document.body, wrap перенесён (не клон), маркер таб-бара,
слот-ghost ≤36px, render при collapsed+пин, драг клэмпит и пишет pinPos
(jsdom rect нулевой — считай от (0,0)), JSON round-trip трёх полей,
collapse-тогл, возврат домой + восстановление КОНВЕРТА (FILL-хаб!),
disposeHubVisuals безопасен для посторонних нод.
ZH — v26 глобальные настройки: дефолт/лестница/лейблы, нормализация мусора,
localStorage round-trip, «тихое» изменение НЕ течёт при events-only, один
тик догоняет, живой интервал 100мс догоняет сам, ⚙-попап (open/select/
persist/акцент/Esc/ре-рендер/выкл).
ZI — v26 вьюверы: isViewerNode-матрица (painter+имя / без painter /
не-вьювер имя / media-поля / хаб), пункт меню только у вьюверов, колбэк
меню биндит, sentinel, srcH, тег «🖼 live», НЕ orphan, locate активен,
canvas смонтирован, тик без бросков, value-refresh не флагает orphan,
тихий ✕, orphan после удаления ноды-источника.
ZJ — v26.2: фильтр «$$» (isInternalWidget; path-1 и панель-список чисты,
viewer-пункту остаётся), isViewerNode по DOM-медиа-виджету без пейнтера
(+негатив: именованная панель с img — не вьювер), findNodeMediaWidget,
end-to-end: video-вьювер монтирует СВОЙ <video controls loop muted>
(госта НЕТ — источник не клонируется), src копируется и вотчер подхватывает
смену (blob:x→blob:y — новая генерация), ZK — v27 галерея: findOutputImages (батч из nodeOutputs, uuid-суффикс
сабграфов, preview-кадры, легаси images/imgs, фильтр видео-расширений),
монтирование галереи (тег живёт, счётчик, миниатюры, active),
setIndex, ремоунт восстанавливает индекс, фуллскрин open/close,
вотчер подхватывает новый батч (idx=0), пропажа стора держит
последний батч, тихий ✕. ZL — v27 звук видео: дефолты, patch,
localStorage round-trip, out-of-range игнор, applyVideoAudio,
boot-рестор нового инстанса модуля. ВНЕ репо — мини-харнесы:
smoke_gallery.mjs / smoke_prefs_lint.mjs (jsdom; app-стаб на
/extensions/<ext>/-layout, requestFullscreen-стаб).
img-маршрут, canvas-блит принимает
размер исходной карты, тихий ✕ у видео-вьювера.

⚠ грабль ZI: фазы не диспатчат onRemoved (ноды вырезаются splice'ом), поэтому
в глобальном реестре копятся хабы прошлых фаз — перед меню-ассертами
очищай реестр (core.forgetHubNode для всех, кроме хаба фазы), иначе
колбэк пункта меню биндит в ПЕРВЫЙ stale-хаб.

```bash
node scripts/smoke_hub.mjs   # базовая линия: >=655 зелёных, 0 упавших
```

Подводные камни харнеса:
- Стаб высот висит на `Element.prototype.scrollHeight` и переживает
  innerHTML; переменная `innerContentH` протухает между фазами — сбрасывай
  в baseline 100 перед AUTO-фазами.
- Пиксельный стаб канвы — ROW-TRACKING (Set закрашенных device-строк на
  канве): setImageData/scanCanvas видят ГДЕ контент. resize буфера
  (canvas.width/height setter) стирает строки — как в браузере; settles
  требуют нескольких тиков: grace 3 → рост по +30 → обрезка. Тик-бюджет
  в тестах: 8–12 `runPortalTicks` на стабилизацию высоты.
- После структурных изменений давай `await sleep(40)` (flush одного rAF).
- Phase X синхронна до `sleep(60)`: mutation batch + rAF heal успевают в
  один сон; jsdom MutationObserver доступен только через `window` realm
  (голый идентификатор в модулях песочницы не определён).
- События вкладок — click по `[data-action="switch-tab"]`; у LiteGraph-like
  колбэков цель дергается вручную (`tw.callback(v)`), затем flush.
- JSDOM создаётся с `url: "http://localhost/"` (иначе opaque origin без
  localStorage), а `globalThis.localStorage = dom.window.localStorage`
  прописан ДО импорта модулей — global_settings читает его на boot.

Правило: любое изменение зеркальных фич сопровождается регресс-проверкой в
подходящей фазе (или новой фазой по букве).

ZP (v28/v29) — smoke_presets_v29.mjs, 78 чек: захват v2 через quick-save
(префикс имени, живая инфа «Will capture … (K row(s) excluded)», excluded
в записи), confirm на перезапись (decline сохраняет снапшот И поповер),
поповер применения (статусы ok/missing-item/missing-widget/combo-invalid,
drift-пара «current → preset», only-changed как view-фильтр, частичное
применение, тост-отчёт вместо in-popover репорта), undo (тост-Undo и ↩
ряда, расходуется, не переживает re-render), чип opt-out (off-состояние,
round-trip, захват мимо исключённых, inPreset сериализуется с графом),
тулзы (bulk include/exclude со счётчиком ИЗМЕНЁННЫХ строк + тост, export
all, import с overwrite-confirm и отказной веткой JSON), пикер (секции
tab/other, свёрнутая чужая группа с бейджем вкладки, поиск по имени и
ЗНАЧЕНИЯМ записей, мульти-токены AND, клавиатура ↑↓/Enter/Esc, fav всплы-
вает стабильно, rename/duplicate/delete/export one/copy, dead-бейдж «⚠K»
с confirm-ветками), merge (обновление по itemId/stable-key, добавление,
чужая вкладка тянет свои строки и переносит scope), stable-key fallback,
клэмп вне границ через coerceNumeric, undo не в cfg. Песочница: клики по
элементам докнутого (detached) хаба работают через el.click(); VirtualConsole
форвардит jsdomError — исключения в слушателях не глотаются.

ZQ (v30–v30.3) — smoke_v30.mjs, 35 чек: ординалы (members[].ord у трёх
одноимённых виджетов, findWidgetOnNode резолвит РАЗНЫЕ объекты по ord,
выход за диапазон → первый, createBinding хранит widgetOrd), multiline
(значение с \n автодетектится, plain-строка остаётся input'ом c чипом ⤢,
чип конвертирует input ↔ textarea.hub-text-area в обе стороны), media-строка
(детект по флагам + фолбэк по onDragOver/onDrop, анти-детект обычной ноды,
createMediaBinding хранит media-мету и переживает syncNode-миграцию, ряд
= превью+combo+📁, превью: фолбэк /view значения combo при пустом сторе,
следует за сменой значения/стора через srcSig, 📁 зовёт РОДНУЮ upload-
кнопку ноды, дроп идёт в onDrop ноды с целыми File (стабы DataTransfer/
DragEvent для jsdom), маршрут B — фетч /upload/image + запись combo +
push в values + тост), меню: 🎬-пункт у лоадера и его отсутствие у обычной
ноды (attachContextMenu зван явно); управляемые высоты v30.2 — свежая
textarea.hub-text-area несёт inline 64px, симуляция перетаскивания грипа
(inline height + pointerup) пишет item.textH, сохранённая высота
восстанавливается после re-render (B5b/B5c/B5d); v30.3 — CSS-контракт:
.hub-text-area несёт ::-webkit-scrollbar + scrollbar-width: thin (выход из
fluent overlay, иначе на Win11/Electron исчезают полоса и грип) и баннер
сборки в settings_hub.js (B7/B8).

ZR (v31) — smoke_v31.mjs, 38 чек: коллапс pin-окна (инлайн-бокс сброшен,
cfg.pinSize переживает свёрнутый период, разворот восстанавливает размер,
глиф -/+, re-render держит шапку); CSS/DOM-контракты (collapsed
width/height auto, скрытый твин .hub-pin-body .hub-tab-bar .hub-pin-toggle
реально в панели, chrome-hidden .hub-tab-del, grip скрыт у свёрнутого);
wheel-слайдеры (+/-step, Shift x10, клэмп объявленной стены, не-перехват
над number-полем и при Ctrl, синтетическое окно растёт односторонне);
layout-контракт (label 45%/56px, hub-mirror-grow у combo/text/num и его
отсутствие у checkbox, .hub-row-tools с margin-left:auto — ровно один на
ряд, с unpin и locate внутри); prune (смена воркфлоу сметает чужой плавающий
хаб и запись реестра, живой остаётся, свежий инстанс рефлоатит по pinPos);
баннер v31. Песочница sb_v31: узлы-фикстуры в graph._nodes + trackHubNode
(эмуляция nodeCreated).

ZS (v32) — smoke_v32.mjs, 17 чек: мягкий ghost-базис (flex-column корень
без float-класса, persisted ghostSplitH = inline height клона,
absolute-fill img остаётся внутри relative image-area клона); graceful
no-op без сохранённой высоты в layoutless-среде (height auto, ничего не
персистится); float opt-in (computed absolute корень получает
.hub-portal-ghost-float); локальный сплит-драг (mousedown -> мгновенный
ресайз панели клона 140->170, направление «вверх = выше», клэмп root-80,
конец по mouseup, форвард в оригинал жив параллельно); продление
touch-лока pointermove (без него rebuild приземлялся ~980мс середрагом;
с продлением — после жеста); ghostSplitH переживает rebuild + драг
перевешивается на свежем клоне; release снимает все зеркала.

ZT (v33) — smoke_v33.mjs, 24 чека: сплит-клоны не получают
.hub-portal-media, а высота корня ставится inline-IMPORTANT (каскад-протест
против author-important правил — корень бага v32); медиа клона не тронуто
(раскладка ведёт стиль пака); graceful no-op в layoutless-среде; фолбэк-
захват по упакованной высоте клона (rect-стаб 210px, персист в item);
media-флейвор жив для обычных виджетов (класс + height:auto); flex-column
без грипа не классифицируется сплитом и высоту не получает; float-легаси;
RO: аттач к оригиналу, обновление item+клона (360px inline-important),
идемпотентность, пауза под touch-локом, изолированность записей,
дисконнект на release; сплит-драг регресс (форвард в оригинал,
140->170, клэмп 220); release чистит и зеркала, и RO.

ZU (v35) — smoke_v35.mjs, 35 чеков: bulk-фабрика (6 из 7 виджетов,
кидающий геттер пропущен, порядки восходящие, пустой батч no-op);
пикер (первый пункт меню ноды, фильтр helper/internal/evil, панель-чип,
цели allHubs + New Tab, счётчик Add, дисклик, виджет-лесс нода без
пункта); сильный реестр (forget/re-track, graph-scan фолбэк не даёт
призраков после forget); контракты загрузчика (баннер v35 до первого
await, диагностика по имени файла, TLA без boot-IIFE, JS-импорты без
query, CSS с ?v=35); watcher на реальных тиках 1.45с — первый тик не
закрывает живое окно, чужой воркфлоу снимает его за тик (pin
выживает), ПУСТОЕ active-множество = observe-only (окно НЕ закрывается),
возврат на вкладку ре-флоатит.

ZV (v38) — smoke_v38.mjs, 16 чеков: paste-роутинг (hover-arm →
node.pasteFiles с точными аргументами, preventDefault + молчание
bubble-шпиона, тост «Pasted», combo хабом не трогается); гарды (без
hover, pointerout-разоружение, editable-фокус, Shift+Ctrl+V, paste
без файлов); kind-фоллтринч (video-файл при hover image-строки
уходит в video-строку через v30-пайплайн: fetch-стаб, combo-запись,
тост «Uploaded»); отказы P1 (pasteFiles()==false и кидающий) падают
в /upload/image; wiring (баннер v38, ?v=38, Ctrl+V в тултипе 📁).
Песочница sb_v38: элемент хаба аппендится в document.body (контракт
arm.zone.isConnected).

ZW (v39) - smoke_v39.mjs, 18 чеков: детекция TrixLoadImageAIO (инстанс
onDropFile + mediaish-combo; негативы: нет проводки / нет mediaish /
прототип-хук), Route A2 нативного аплоада через paste-P3 (fetch
молчит, combo пишет пак) с фолбэками decline/throw -> /upload/image;
превью: firstMediaSpec input-фильтр (источник, не processed-output),
subfoldered combo-значения -> subfolder+filename в /view.

ZX (v40) - smoke_v40.mjs, 28 чеков: меню-квалификация
(Switch/MuteSwitch = один пункт; негативы: combo/panel/viewer/media
не дублируются, хаб-нода немая), биндинг (viewer-shape + controls +
якоря), монтаж форграунд-портала (canvas, реальная покраска,
тег выживает), интерактивность (pointerdown -> onMouseDown
node-local, wheel/contextmenu гасятся, pointerleave), релиз
(ремаунт без гостов, анпин чистит), wiring (баннер v40, ?v=40).

ZY (v41) - smoke_v41.mjs, 30 чеков: авто-сворачивание пин-окна
(кнопка ⇲ в шапке, cfg.pinAutoHide), leave -> fold c grace-задержкой
и отменой по re-entry, hover заголовка свернутого -> expand c
intent-задержкой и отменой, блокировка fold открытыми body-попапами
(.hub-menu/.hub-fs-overlay), drag-гвард + endDrag-recovery (mouseup
на body = отпускание указателя вне окна), режим OFF замораживает
оба направления, v31-контракт размеров через applyPinMin,
teardown-гигиена + персистентность через re-pin, wiring (баннер
v41, ?v=41). Урок: jsdom 30 :hover = «last mouse-family event
target inside node» (currentEvent персистентен).

ZZ (v42) - smoke_v42.mjs, 17 чеков: same-id слепая зона вотчера
(свитч с теми же id без lifecycle/хуков — сигнатура не меняется,
окно должно уйти), folded-parity (свёрнутое окно — паритет с
развёрнутым), resurrection gate (снятое за мёртвые строки окно
переживает правки графа и ре-флоатится только с живыми строками),
foreign-бредкрамб ровно один за сессию, wiring (баннер v42,
?v=42, rootSig/lastSig удалены, everActive сохранён).

## 6. Упаковка и коммиты

```bash
# артефакт для установки в ComfyUI/custom_nodes (без .git/__pycache__)
zip -rq ComfyUI-Settings-Hub.zip ComfyUI-Settings-Hub \
    -x "*.git*" -x "*__pycache__*" -x "*.pyc"
```

Коммиты — Conventional Commits (`feat(scope): ...`, `fix(ui): ...`,
`docs: ...`). Стоящее правило проекта (контракт пользователя, v36):
названия коммитов пишет АССИСТЕНТ — коммитит каждый фикс/фичу сам и
приводит название коммита в ответе пользователю, включая
ретроспективные. Пользователь названия не придумывает.

Отладка в реальном ComfyUI: F12 → Console (ошибки модулей всплывают при
загрузке страницы), либо жёсткое обновление фронта (Ctrl+F5) после замены
файлов `web/`.
