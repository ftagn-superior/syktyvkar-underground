# Актуализация документации S-35

14 ноября 2026 года. Основа: `main`, `8802c3b69cd324c94a27ea8ae7730d1017d06c19`. Инвентаризированы все **83 отслеживаемых Markdown-файла** исходной ревизии: рабочие документы сверялись с кодом и конфигурацией, планы — с реализацией и отчётами, исторические материалы — по назначению и ссылкам. Добавлены указатель оставшихся планов и этот отчёт.

**Тесты, сборки клиента, сервера и миров не выполнялись по прямому указанию владельца. Серверы и БД не запускались.** Проверка ограничена чтением исходников, diff, поиском старых формулировок и статической проверкой относительных Markdown-ссылок и якорей. Реально собранный мир, production, внешние сайты и аппаратные сценарии этим прогоном не проверялись.

## Изменения и основания

| Область | Исправление | Основание в исходниках |
| --- | --- | --- |
| Версии | Протокол 21, мир 5, ячейки 2, PostgreSQL 8 в рабочих требованиях; номера отдельных исторических миграций сохранены | `packages/contracts/src/session.ts`, `world-types.ts`, `world-bundle.ts`; `apps/server/src/migrations.ts` |
| Миры | Четыре мира: `ring-block`, `physics-lab`, `streaming-lab`, `terrain-lab` | `tools/world-build/src/index.ts`, `WORLDS` |
| Город | 392 ячейки по 125 м и 392 модели основания, исходное расширение с покрытиями улиц и 1829 упрощёнными зданиями | Границы в `terrain-release.json.groundTerrain.header`, разбиение в сборщике; `world.json.cells`, `cells/expansion-buildings.json` |
| Рельеф | Активная сглаженная сетка с шагом 20 м; материалы прежних сеток 2/4 м обозначены как происхождение и история | `content/worlds/ring-block/terrain-release.json`, `terrain-smoothed/grid.json` |
| Каталог | Текущая палитра из 24 моделей, включая два дорожных ограждения; первоначальные 22 ассета библиотеки остаются историей отдельного этапа | `content/worlds/ring-block/placement.json` |
| Права | `/giveme`, `/motherlode`, `/vilievna` и прочие консольные команды требуют авторизованного администратора; обычный инвентарь аккаунта не получает такого ограничения | `WorldRoom.adminAccess`, `accounts.is_admin` |
| Статика | Убраны противоречащие реализации заявления об отсутствии live-редактирования; отдельно описаны создание/удаление из игры и офлайн-изменение ресурсов/поз | `apps/server/src/layout/`, `packages/world-release/`, клиентские placement/removal |
| Профиль | «Войти гостем» / «Войти в мир», сохранение профиля при входе; отсутствующая отдельная кнопка удалена из инструкций | `apps/client/index.html`, `ui/account-panel.ts` |
| Рюкзак | Группировка по типу и свойствам, суммарное количество, размещение выбором плитки; серверные `split/merge/move` не представлены как кнопки UI | `apps/client/src/ui/inventory.ts`, `groupInventory`; серверный контракт предметов сохранён |
| Чат | По умолчанию Enter сворачивает поле, Shift+Enter оставляет его открытым; документирована локальная настройка | `apps/client/src/ui/chat-settings.ts` |
| Персонажи | Восемь скинов на общем каркасе; покрытие браузерных сценариев `standard`/`minifigure` не расширено словами до всех восьми | `packages/contracts/src/avatars.ts`, исходники браузерных сценариев |
| Позиции | Убрано отрицание сохранения позиции аккаунта; уточнены проверка при входе и явный terrain-перенос Y | `apps/server/src/players/`, `WorldRoom`, terrain migration |

392 ячейки получены из исходных границ 3500 × 1700 м и алгоритма сетки 125 м (28 × 14), а не из новой сборки. Число 1829 относится к исходному seed; содержимое существующей БД не выводилось из него. Состояние кода отделено от датированных подтверждений прежних поставок, без назначения новой production-ревизии.

## Архив и история

В [архив](../docs/archive/README.md) перенесены восемь заданий и планов: выделение объектов, миграция статики, типовая библиотека, ядро размещения, каталог `/motherlode`, live-оптимизация, эксперимент terrain-lab и внедрение городского рельефа. У каждого есть пояснение исторического назначения и ссылка на рабочие инструкции. Первоначальные требования, числа и статусы проверок сохранены; незавершённая ручная/аппаратная приёмка не закрыта архивированием.

Отчёт типовой библиотеки перенесён из `docs/` в [reports/static-asset-library.md](static-asset-library.md). Его измерения и результаты сохранены. В прежних отчётах исправлены только ссылки на перенесённые документы. В [указателе планов](../docs/plans/README.md) оставлены дальнейшие этапы и открытая приёмка. Полезная история сохранена; удаления без архивной копии не потребовалось.

В старых исследованиях остаются исходные шаблоны ссылок, упоминания чужих структур каталогов и прежних outputs. Ссылки отчётов на игнорируемые `output/` указывают на локальные артефакты тех прогонов, которых нет в свежем клоне. Это не ссылки на рабочие инструкции и не свидетельства нового запуска. Их содержимое и измерения не переписывались. Старые пути в `reports/static-object-extraction-legacy.json` также относятся к исходному историческому срезу; машинный реестр не изменялся.

Статический проход охватил 85 Markdown-файлов результата и 768 вхождений относительных ссылок. В рабочих документах битых файловых ссылок и якорей не найдено. 35 находок относятся к исходным шаблонам и ссылкам архивного исследования, ещё 10 — к отсутствующим локальным артефактам прошлых отчётов. Сравнение 45 исторических текстов с исходной ревизией подтвердило сохранность содержимого, кроме перенаправления ссылок и добавленных архивных пояснений. `git diff --check` прошёл; перечень изменений содержит только Markdown.

## Сохранённые границы

- Предложения Q1–Q9 из S-28 пропущены: обещания персонажей, авторские предметы и иконки, «Сплюс», гостевые тексты, роль UI-макета, новый канон статуса выпуска/MVP и внешние метаданные не переопределялись.
- D10/S-28 требует продуктового решения о сенсорном рюкзаке и подборе. Противоречие согласованного touch-плана с кодом зафиксировано, но единый новый объём поддержки не объявлен. Предполагаемая поддержка авторизованного подбора на телефоне не выдаётся за пройденную приёмку.
- Пользовательские строки «Полигон» и `Tech demo` в реализации остаются отдельной работой S-28. Конфигурация `.env.example`, права, игровые механики, авторский контент и данные не изменены.
- Подтверждение владельца от 12 ноября и сведения о прежнем переносе рельефа сохранены в исходном объёме. Новые поставки, приёмка телефонов, Xbox и полного режима первого лица не подтверждались.

## Покрытие Markdown

Ниже перечислены все файлы исходной ревизии с текущим местом и результатом просмотра. «История» означает проверку назначения и ссылок без повторения измерений; «без правки» — отсутствие подтверждённого расхождения либо сохранение явно исключённого вопроса.

| Документ после актуализации | Результат |
| --- | --- |
| [README.md](../README.md) | Рабочее описание обновлено по исходникам |
| [apps/client/public/audio/README.md](../apps/client/public/audio/README.md) | Назначение фикстур/локальных ресурсов сохранено |
| [content/buildings/AGENTS.md](../content/buildings/AGENTS.md) | Без правки: подтверждённых расхождений не найдено |
| [content/worlds/ring-block/expansion-buildings/README.md](../content/worlds/ring-block/expansion-buildings/README.md) | Без правки: подтверждённых расхождений не найдено |
| [content/worlds/ring-block/ground-expansion/README.md](../content/worlds/ring-block/ground-expansion/README.md) | Без правки: подтверждённых расхождений не найдено |
| [content/worlds/ring-block/terrain-candidate/README.md](../content/worlds/ring-block/terrain-candidate/README.md) | Рабочее описание обновлено по исходникам |
| [content/worlds/ring-block/terrain-expansion/README.md](../content/worlds/ring-block/terrain-expansion/README.md) | Рабочее описание обновлено по исходникам |
| [docs/PROJECT_CONTEXT.md](../docs/PROJECT_CONTEXT.md) | Рабочее описание обновлено по исходникам |
| [docs/README.md](../docs/README.md) | Рабочее описание обновлено по исходникам |
| [docs/architecture.md](../docs/architecture.md) | Рабочее описание обновлено по исходникам |
| [docs/archive/README.md](../docs/archive/README.md) | История; исправлены только ссылки |
| [docs/archive/pre-pre-search.md](../docs/archive/pre-pre-search.md) | История, без правки |
| [docs/archive/pre-search.md](../docs/archive/pre-search.md) | История, без правки |
| [docs/art-style-guide.md](../docs/art-style-guide.md) | Без правки: подтверждённых расхождений не найдено |
| [docs/audio.md](../docs/audio.md) | Рабочее описание обновлено по исходникам |
| [docs/avatar-skins.md](../docs/avatar-skins.md) | Рабочее описание обновлено по исходникам |
| [docs/building-assets.md](../docs/building-assets.md) | Рабочее описание обновлено по исходникам |
| [docs/character-animation.md](../docs/character-animation.md) | Рабочее описание обновлено по исходникам |
| [docs/items-inventory-and-world-persistence.md](../docs/items-inventory-and-world-persistence.md) | Рабочее описание обновлено по исходникам |
| [docs/large-map-streaming.md](../docs/large-map-streaming.md) | Рабочее описание обновлено по исходникам |
| [docs/map-model-guide.md](../docs/map-model-guide.md) | Рабочее описание обновлено по исходникам |
| [docs/operations.md](../docs/operations.md) | Рабочее описание обновлено по исходникам |
| [docs/plans/city-expansion.md](../docs/plans/city-expansion.md) | Реализованный контракт и открытая приёмка сохранены |
| [docs/plans/first-person-mode.md](../docs/plans/first-person-mode.md) | Реализованный контракт и открытая приёмка сохранены |
| [docs/plans/gamepad-controls-mvp.md](../docs/plans/gamepad-controls-mvp.md) | Реализованный контракт и открытая приёмка сохранены |
| [docs/archive/plans/motherlode-placement-catalog.md](../docs/archive/plans/motherlode-placement-catalog.md) | История: архив, исходные требования сохранены |
| [docs/plans/player-position-persistence-mvp.md](../docs/plans/player-position-persistence-mvp.md) | Рабочее описание обновлено по исходникам |
| [docs/archive/plans/ring-terrain-integration.md](../docs/archive/plans/ring-terrain-integration.md) | История: архив, исходные требования сохранены |
| [docs/archive/plans/static-asset-library-and-instancing.md](../docs/archive/plans/static-asset-library-and-instancing.md) | История: архив, исходные требования сохранены |
| [docs/archive/plans/static-layout-live-optimization.md](../docs/archive/plans/static-layout-live-optimization.md) | История: архив, исходные требования сохранены |
| [docs/archive/plans/static-placement-core-mvp.md](../docs/archive/plans/static-placement-core-mvp.md) | История: архив, исходные требования сохранены |
| [docs/archive/plans/terrain-lab-experiment.md](../docs/archive/plans/terrain-lab-experiment.md) | История: архив, исходные требования сохранены |
| [docs/plans/touch-controls-mvp.md](../docs/plans/touch-controls-mvp.md) | Без правки: согласованный touch-объём; D10/S-28 исключён |
| [docs/plans/ui-rework/README.md](../docs/plans/ui-rework/README.md) | Без правки: Q6/S-28 исключён |
| [docs/plans/ui-rework/current-state.md](../docs/plans/ui-rework/current-state.md) | Без правки: Q6/S-28 исключён |
| [docs/plans/ui-rework/design-spec.md](../docs/plans/ui-rework/design-spec.md) | Без правки: Q6/S-28 исключён |
| [docs/player-animations.md](../docs/player-animations.md) | Рабочее описание обновлено по исходникам |
| [docs/ring-block.md](../docs/ring-block.md) | Рабочее описание обновлено по исходникам |
| [reports/static-asset-library.md](static-asset-library.md) | История: перенесён в reports, измерения сохранены |
| [docs/archive/static-object-extraction-agent.md](../docs/archive/static-object-extraction-agent.md) | История: архив, исходные требования сохранены |
| [docs/archive/static-world-migration-plan.md](../docs/archive/static-world-migration-plan.md) | История: архив, исходные требования сохранены |
| [docs/streetview-reference.md](../docs/streetview-reference.md) | Без правки: подтверждённых расхождений не найдено |
| [docs/terrain-lab.md](../docs/terrain-lab.md) | Рабочее описание обновлено по исходникам |
| [docs/testing.md](../docs/testing.md) | Без правки: подтверждённых расхождений не найдено |
| [docs/ui.md](../docs/ui.md) | Рабочее описание обновлено по исходникам |
| [docs/world-model-catalog.md](../docs/world-model-catalog.md) | Рабочее описание обновлено по исходникам |
| [reports/README.md](README.md) | Указатель дополнен |
| [reports/acceptance.md](acceptance.md) | История, без правки |
| [reports/audio-mvp-audit.md](audio-mvp-audit.md) | История, без правки |
| [reports/audio-mvp-implementation.md](audio-mvp-implementation.md) | История, без правки |
| [reports/avatar-skins.md](avatar-skins.md) | История, без правки |
| [reports/buildings.md](buildings.md) | История, без правки |
| [reports/characters.md](characters.md) | История, без правки |
| [reports/documentation-audit.md](documentation-audit.md) | История, без правки |
| [reports/dynamic-map-integration.md](dynamic-map-integration.md) | История, без правки |
| [reports/first-person-mode.md](first-person-mode.md) | История, без правки |
| [reports/gamepad-controls-mvp.md](gamepad-controls-mvp.md) | История, без правки |
| [reports/large-map.md](large-map.md) | История, без правки |
| [reports/motherlode-placement-catalog.md](motherlode-placement-catalog.md) | История; исправлены только ссылки |
| [reports/network.md](network.md) | История, без правки |
| [reports/physics.md](physics.md) | История, без правки |
| [reports/player-animations.md](player-animations.md) | История, без правки |
| [reports/player-position-persistence-mvp.md](player-position-persistence-mvp.md) | История, без правки |
| [reports/polish.md](polish.md) | История, без правки |
| [reports/refactoring.md](refactoring.md) | История, без правки |
| [reports/ring-terrain-expansion.md](ring-terrain-expansion.md) | История, без правки |
| [reports/ring-terrain-ground-evaluation.md](ring-terrain-ground-evaluation.md) | История, без правки |
| [reports/ring-terrain-smoothing.md](ring-terrain-smoothing.md) | История, без правки |
| [reports/ring-terrain-stage0.md](ring-terrain-stage0.md) | История; исправлены только ссылки |
| [reports/ring-terrain-stage1.md](ring-terrain-stage1.md) | История; исправлены только ссылки |
| [reports/ring-terrain-stage2.md](ring-terrain-stage2.md) | История; исправлены только ссылки |
| [reports/ring-terrain-stage3.md](ring-terrain-stage3.md) | История; исправлены только ссылки |
| [reports/ring-terrain-stage4.md](ring-terrain-stage4.md) | История, без правки |
| [reports/ring-terrain-stage5.md](ring-terrain-stage5.md) | История; исправлены только ссылки |
| [reports/ring-terrain-stage6.md](ring-terrain-stage6.md) | История; исправлены только ссылки |
| [reports/static-layout-live-optimization.md](static-layout-live-optimization.md) | История, без правки |
| [reports/static-object-extraction.md](static-object-extraction.md) | История, без правки |
| [reports/static-placement-core-mvp.md](static-placement-core-mvp.md) | История; исправлены только ссылки |
| [reports/static-removal.md](static-removal.md) | История, без правки |
| [reports/terrain-lab-experiment.md](terrain-lab-experiment.md) | История; исправлены только ссылки |
| [reports/touch-controls-mvp.md](touch-controls-mvp.md) | История, без правки |
| [tests/fixtures/static-extraction/README.md](../tests/fixtures/static-extraction/README.md) | Назначение фикстур/локальных ресурсов сохранено |
| [tests/fixtures/static-library-v1/README.md](../tests/fixtures/static-library-v1/README.md) | Назначение фикстур/локальных ресурсов сохранено |
