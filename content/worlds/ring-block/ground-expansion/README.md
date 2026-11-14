# Основание новой территории ring-block

Слои дорог, проездов, дорожек, парковок, газонов, парков, спортплощадок, детских площадок
и воды вне старой области (X −269…331, Z −745…131) получены разово из OpenStreetMap
и сохранены в обычном рецепте `content/buildings/ring-block/ring-block-ground/source.json`.
`pnpm world:build` OSM не читает и в сеть не ходит.

Данные © участники OpenStreetMap, лицензия [ODbL 1.0](https://opendatacommons.org/licenses/odbl/).
Запрос, время снимка, SHA-256 и счётчики по слоям — в `provenance.json`.

## Пересчёт

```sh
pnpm world:ground:expansion -- --fetch   # новый снимок Overpass → output/expansion-ground/osm.json
pnpm world:ground:expansion              # пересчитать из сохранённого снимка
```

Генератор (`tools/world-build/src/expansion-ground.ts`) удаляет прежние полигоны вне
старой области и строит их заново; полигоны старой области не меняются. Линии улиц
буферизуются, площади объединяются и режутся по ячейкам 125 м через поле расстояний
(`ground-contour.ts`), без внешних библиотек. Ширины:

| OSM                                                    | Слой      | Ширина                                                                                                                 |
| ------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `primary`…`residential`, `living_street`, `*_link`     | `road`    | max(`width`, полосы × 2,75 м) + 3 м; полосы из `lanes`, иначе 4 для `primary`/`trunk`, 2 для остальных, 1 для `*_link` |
| `service` / `track`                                    | `service` | 5 м / 4 м                                                                                                              |
| `footway`, `path`, `cycleway` / `steps` / `pedestrian` | `footway` | 1,8 м / 2 м / 4 м                                                                                                      |
| `stream` / `canal` / `ditch`, `drain`                  | `water`   | `width` или 2,5 м / 6 м / 1,2 м                                                                                        |

Тоннели пропускаются. Разметки на новых улицах пока нет. Река Сысола берётся из мультиполигона воды; её осевая линия без
`width` не буферизуется. Разметка, деревья и здания новой территории — следующие этапы
[плана](../../../../docs/plans/city-expansion.md).

## Расширение улиц старой области

`pnpm world:ground:widen` (`tools/world-build/src/widen-roads.ts`) — разовая операция от
14.11.2026: дороги +1,5 м с каждой стороны, проезды +0,65 м, кольцо (R < 47 м) без
изменений с плавным переходом к 62 м. Скрипт применяется только к исходной версии
основания (проверка SHA-256) и сдвигает деревья, кусты и мелкие объекты с нового
асфальта в seed и `seedY` (90 объектов; четыре дерева у X 166…212, Z −407…−370
скрипт не смог вынести и оставил на месте). Для действующей БД — после сборки и
`world:migrate` нового выпуска, при остановленном мире:

```sh
make map-export FILE=output/base.json
pnpm world:ground:widen -- --layout output/base.json --out output/edited.json
make map-patch BASE=output/base.json EDITED=output/edited.json PATCH=output/widen.patch.json
make map-check PATCH=output/widen.patch.json && make map-apply PATCH=output/widen.patch.json
```
