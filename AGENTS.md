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
web/settings_hub.js    — точка входа: app.registerExtension, загрузка CSS
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
                         createNewHub — канонический LiteGraph.createNode -> graph.add
web/sync.js            — шина структурных/values-обновлений + shared edit-lock
                         (beginEdit/endEdit), rAF-очередь queueHubRefresh
web/sync_manager.js    — хуки реактивности на целевых виджетах (обёртка callback),
                         writeTargetValue под lock'ом, invokeTargetButton
                         (запуск запиненной кнопки на ЖИВОЙ ноде,
                         никогда не трогает .value), self-healing вызовы
web/hub_ui_renderer.js — весь UI хаба: табы, строки зеркал, searchable combo
                         popup, gear-поповер кастомных min/max/step (.hub-num-pop,
                         Apply/Push/Clear + checkbox auto-apply), layout-движок
                         (AUTO/FILL), события (делегирование)
web/hub_node.js        — класс узла: onResize (user vs auto sizing),
                         бейдж 📌 через обёртку LGraphCanvas.drawNode
web/context_menu.js    — пиннинг: ПКМ по hover-виджету; пункт меню ноды
                         "Pin custom panel"; перехват Ctrl/Cmd+ПКМ (capture)
web/portal_manager.js  — живые встраивания: DOM-панели — GHOST-ЗЕРКАЛА
                         (неcтруктивный клон в хабе, оригинал НИКОГДА не
                         покидает ноду; события клона → реэвент на
                         counterpart, мутации оригинала → debounce-rebuild;
                         лок на фокус/недавний ввод), canvas-порталы,
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
   касания (pointerdown/wheel/key/focusin); занятая цепочка
   перезаказывается по 400мс, не теряется. contextmenu НЕ форвардится.
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

```bash
node scripts/smoke_hub.mjs   # базовая линия: >=486 зелёных, 0 упавших
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

Правило: любое изменение зеркальных фич сопровождается регресс-проверкой в
подходящей фазе (или новой фазой по букве).

## 6. Упаковка и коммиты

```bash
# артефакт для установки в ComfyUI/custom_nodes (без .git/__pycache__)
zip -rq ComfyUI-Settings-Hub.zip ComfyUI-Settings-Hub \
    -x "*.git*" -x "*__pycache__*" -x "*.pyc"
```

Коммиты — Conventional Commits (`feat(scope): ...`, `fix(ui): ...`,
`docs: ...`). Стоящее правило проекта: КАЖДОМУ фиксу/фиче — название
коммита в ответе пользователю, включая ретроспективные.

Отладка в реальном ComfyUI: F12 → Console (ошибки модулей всплывают при
загрузке страницы), либо жёсткое обновление фронта (Ctrl+F5) после замены
файлов `web/`.
