# NOVANTIQ WMS: guía para revisar la demo y camino al piloto

**Demo:** https://brianmettica97-creator.github.io/novantiq-wms/dist/wms-demo.html
(funciona en compu y celular, sin instalar nada)

La demo simula un turno en un centro de distribución de consumo masivo: 1.920 posiciones en 6 pasillos y 4 niveles
(2 pallets por bahía), 1.500 pallets (≈78 % de ocupación) de 60 productos y 3 clientes, 6 clarks retráctiles y 6 muelles
(2 de recepción y 4 de despacho).
Todo lo que se ve sale de esa simulación: no son pantallas armadas a mano.

## Recorrido sugerido (5 minutos)

0. **Tocá "▶ Recorrido guiado"** (arriba): un paseo automático de 90 segundos por todo el sistema. Con `Esc` salís.
1. **Mapa 3D.** Arrastrá para girar y usá la rueda para acercar. El botón `⇶` te lleva a la cabecera de cada pasillo.
   En modo **Realista** las cajas se ven como en el depósito y el indicador (rotación ABC, vencimiento, estado) va en la
   etiqueta de color de cada pallet; en modo **Análisis** se pinta toda la carga. Si la compu va lenta, bajá la *Calidad*.
   **Buscador**: escribí un producto (por ejemplo *Yerba*), un SKU o un LPN y se ilumina el pallet que sale primero por FEFO,
   con el clark más cercano y cuánto tarda en llegar.
2. **Tocá una ubicación.** Vas a ver el pallet, el lote, el vencimiento, el último conteo y la **historia del pallet**:
   quién lo recibió, con qué remito, quién lo guardó y cuándo.
3. **Activá "Slotting inteligente".** Los productos de alta rotación se acercan al muelle de despacho y
   el *índice de recorrido* (metros por picking) baja. Abajo se ve el ahorro estimado en km y horas de clark por mes.
4. **Tocá un clark: es la tablet del operario.**
   - PIN de ingreso (en la demo: **1234**).
   - **Checklist de seguridad** del autoelevador. Marcá una "Falla" y el clark se detiene en el mapa
     hasta que el supervisor lo habilite.
   - Con una tarea de picking, tocá **"Escanear otro"**: el sistema frena la salida si el pallet no respeta
     **FEFO** (hay otro del mismo producto que vence antes) y pide autorización del supervisor, que queda registrada.
   - **Reportar problema**: ubicación ocupada, pallet dañado, faltante o etiqueta ilegible.
5. **Modo "Carga (kg)"** (arriba del mapa): colorea cada posición según cuánto peso tiene su viga. En la ficha de una
   ubicación se ve el peso del pallet y la carga de la viga y del módulo. El sistema nunca guarda un pallet donde el
   rack no lo aguanta (1.200 kg por posición, 2.000 kg por par de vigas, 5.400 kg por módulo) y manda los pesados abajo.
6. **Panel "Gestión del depósito"** (columna derecha):
   - *Inventario*: **exactitud de stock** con conteo cíclico. Un operario cuenta unas 30 ubicaciones por hora,
     empezando por los productos A, y el sistema ajusta las diferencias que encuentra. También muestra la proyección de ocupación.
   - *Clientes*: pallets por cliente, **plata en riesgo por vencimiento** y **facturación estimada**
     (almacenaje por pallet-día + entradas + salidas).
   - *Recepción*: cada camión con su remito y las **diferencias** detectadas: cajas de menos, vencimiento corto o lote no declarado.
   - *Problemas*: lo que reportaron los operarios.
7. **"📋 Resumen del turno"** (arriba): el mensaje que recibiría el dueño al cierre, listo para WhatsApp.

## Qué está simulado y qué es real

| | Estado |
|---|---|
| Peso de pallets y capacidad de racks | **Real** en el motor y la demo; en la base está la función y el trigger (falta probarlos con datos reales). Las capacidades son típicas: en un piloto salen de la placa de carga del rack |
| Motor de slotting ABC, putaway inteligente y FEFO | **Real.** Es el mismo código que usa el sistema y tiene tests automáticos |
| Base de datos PostgreSQL (stock inmutable, multi-cliente, dos clarks nunca toman la misma tarea) | **Diseñada** (`db/schema.sql`). Falta ponerla en marcha y testearla con datos reales |
| Conteo cíclico, recepción contra remito, facturación, checklist, resumen | **Lógica real y testeada en la demo.** Falta llevarla a la base de datos y a la app de la tablet |
| Tarifas, valores de mercadería, proveedores, diferencias | **De ejemplo.** En un piloto salen de los contratos y del ERP |
| Lector de códigos | **Simulado con botones.** En la tablet real es un lector USB/Bluetooth que funciona como teclado |
| Login y permisos por rol | En la demo, solo el PIN de la tablet |
| Integración con el ERP del cliente (SAP u otro) | **Pendiente.** Depende de qué ERP use cada cliente |

## Camino al piloto (en orden)

1. **Base de datos y API funcionando** con un depósito real (layout, productos, stock inicial).
2. **Usuarios y PIN por operario**, con permisos: dueño, supervisor, recepción y clarkista.
3. **Etiquetas** con código de pallet (LPN) al recibir, impresas en impresora térmica (ZPL).
4. **Recepción contra remito u orden de compra**, con recepción ciega opcional.
5. **Inventario cíclico** con la tablet.
6. **Facturación por cliente** con sus tarifas reales y exportación a Excel/ERP.
7. **Tablet sin wifi** (modo offline) para los sectores sin señal.
8. Después: olas de picking, **picking por cajas** (no solo pallets completos), agenda de muelles e integración con ERP.

## Preguntas para vos (lo que más nos ayuda)

1. ¿Cómo miden hoy la **exactitud de stock** y cada cuánto cuentan? ¿Qué valor consideran aceptable?
2. ¿Cómo **cobran el almacenaje**: pallet-día, posición fija, m² o un mínimo mensual? ¿Qué se cobra aparte?
3. ¿Despachan **pallets completos o arman pedidos por caja o unidad**? Esto cambia mucho el diseño.
4. ¿Qué tan seguido llegan **diferencias contra el remito** y cómo se resuelven hoy con el proveedor?
5. ¿Qué **ERP** usan los clientes y cómo les pasan hoy los pedidos (mail, Excel, sistema)?
6. Mirando la demo: ¿**qué falta o qué sobra** para que lo usen en el día a día? ¿Qué le cambiarías a la tablet del clark?
7. ¿Qué **capacidad de carga** tienen sus racks (por par de vigas y por módulo) y cómo controlan hoy que no se excedan? ¿Usan alguna regla de pesados abajo?
