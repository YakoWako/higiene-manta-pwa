# Diagnóstico inicial de los insumos geográficos

Fecha de revisión: 15/09/2026

## Inventario cargado

- Matriz: **108 puntos críticos**.
- Puntos con coordenadas: **107**.
- Punto sin coordenada: **SM1** (San Mateo).
- Capa de barrios: **231 polígonos**.
- Capa de parroquias: 11 placemarks en el KML original; el prototipo usa 10 polígonos/entidades con nombre para la consulta principal y deja el polígono sin nombre como referencia aparte.

## Hallazgos que conviene depurar antes de una versión institucional

### Cobertura de barrios

Al cruzar las 107 coordenadas disponibles contra los polígonos de barrios:

- 9 puntos no caen dentro de ningún polígono barrial: **M8, M19, LE4, LE5, LE22, UM3, SL1, SL2 y SL3**.
- 2 puntos caen dentro de polígonos cuyo nombre es `noname`: **LE12 y LE24**.
- La capa de barrios contiene 10 polígonos sin nombre o con nombre `noname`.

Esto significa que, en esos sectores, la PWA puede mostrar **“Fuera de polígono”** o un nombre no útil aunque el GPS sea correcto. No es un fallo del aplicativo: es un asunto de cobertura/atributos de la capa geográfica que conviene corregir.

### Cobertura de parroquias

Al cruzar las coordenadas contra la capa parroquial, **M8** y **LE22** no caen dentro de ningún polígono parroquial. Los demás puntos con coordenadas sí encuentran un polígono parroquial coherente con el inventario.

### Punto SM1

SM1 consta en la matriz como punto activo de San Mateo, pero no tiene latitud/longitud. Permanecerá disponible en el listado, pero no puede mostrarse en el mapa ni calcularse su distancia hasta que se agregue una coordenada.

## Criterio aplicado en el prototipo

- La **matriz consolidada** se usa como fuente de atributos del punto crítico (código, referencia, estado, frecuencia, propiedad, residuos, etc.).
- Los **KML de barrios y parroquias** se usan para identificar territorialmente la posición GPS real del supervisor.
- Si la coordenada cae fuera de un polígono, el sistema no inventa el barrio/parroquia: lo advierte.
- Si la ubicación está cerca del límite de un barrio, el sistema compara distancia al lindero con la precisión reportada por el GPS y muestra una alerta de verificación.
