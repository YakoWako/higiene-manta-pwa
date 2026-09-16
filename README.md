# Higiene Manta - PWA de Gestión Territorial (prototipo v0.3.1)

## Qué incluye esta versión

- Pantalla inicial institucional y escalable: hoy solo muestra el módulo **Evacuación de puntos críticos**. No existen módulos vacíos o inactivos.
- Separación de acceso en dos dimensiones: **consulta pública** (GPS, barrio, parroquia, mapa y fichas) y **operación protegida** (registro y gestión de evacuaciones).
- Acceso de supervisor mediante PIN para las pestañas Registrar y Pendientes, con cierre de sesión manual y vencimiento automático de la autorización.
- Diseño móvil vertical, responsive también en escritorio.
- Capas locales de **231 barrios**, parroquias y **108 registros de puntos críticos** obtenidos de los archivos entregados.
- Consulta GPS mejorada: recoge varias lecturas durante unos segundos y utiliza la más precisa disponible.
- Muestra las coordenadas exactas que se están usando para poder contrastarlas con Google Earth.
- Si la lectura cae apenas fuera de un polígono pero el margen de error GPS alcanza un barrio, lo presenta como **barrio probable** en lugar de descartarlo automáticamente.
- Alerta cuando la precisión GPS y la cercanía al límite hacen ambigua la ubicación.
- Cálculo del punto crítico más cercano y distancia.
- Mapa principal con **Leaflet + OpenStreetMap** cuando existe Internet: calles, avenidas, costa y referencias urbanas.
- Navegación táctil natural en el mapa: arrastre, zoom con dos dedos, doble toque y controles +/−.
- Respaldo territorial offline: si el mapa vial o Leaflet no están disponibles, la PWA conserva barrios, parroquias, puntos y GPS mediante el mapa vectorial simplificado local.
- Semaforización de puntos compatible con la matriz institucional: **rojo = Activo, amarillo = Desplazado/inactivo, verde = Eliminado**.
- Filtro de puntos por estado: Activo / Desplazado-inactivo / Eliminado / Todos.
- Formulario de evacuación optimizado para evitar volver a escribir parroquia, barrio, referencia, coordenadas y tipo de propiedad.
- Registro de fecha/hora de inicio y fin con botones.
- Caracterización porcentual de residuos con validación de suma = 100%.
- Captura de foto ANTES / DESPUÉS.
- Guardado offline en IndexedDB y cola de sincronización.
- Service Worker + manifest para instalación como PWA.
- Backend de referencia en Google Apps Script para enviar datos a Sheets y fotos a Drive.

## Decisiones aplicadas al formulario actual

Se eliminaron del flujo operativo del prototipo los datos que no es necesario pedir manualmente en este módulo, como código de autorización, respuesta "¿Punto crítico?", parroquia, barrio, coordenadas y referencia. Esos valores se derivan del punto seleccionado y/o GPS.

Se conservaron las variables operativas que requieren observación del supervisor: fuente del pedido, caracterización del terreno, caracterización de residuos, vehículo, propiedad, equipo de carga, capacidad, viajes, fotos y observaciones.

La identidad visual es **provisional**. No se utilizó un logotipo oficial porque aún no se proporcionó el archivo institucional.


## Acceso público y acceso de supervisor

La consulta territorial está abierta para cualquier persona que tenga el enlace. No solicita PIN para usar el GPS, identificar barrio/parroquia, visualizar el mapa ni revisar la ficha de un punto crítico.

Las funciones **Registrar evacuación** y **Pendientes / Sincronización** están protegidas. En este prototipo la comprobación del PIN se realiza localmente mediante una huella criptográfica y la autorización se conserva temporalmente en el dispositivo. Esto permite probar el flujo incluso sin Internet.

**Importante para la versión institucional:** un PIN de cuatro dígitos validado únicamente en el navegador sirve como control operativo del piloto, pero no debe considerarse autenticación de alta seguridad. Antes de habilitar la sincronización real para un enlace de uso público, la validación se trasladará al backend de Google Apps Script y el dispositivo conservará solamente una autorización temporal para continuar trabajando offline.

## Cómo probar en un computador

La PWA debe abrirse desde HTTP/HTTPS (no haciendo doble clic en index.html) para que Service Worker y GPS trabajen correctamente.

En la carpeta del proyecto ejecute, por ejemplo:

```bash
python -m http.server 8080
```

Luego abra `http://localhost:8080`.

Para probar el GPS real en un celular se recomienda publicar temporalmente el proyecto en un alojamiento HTTPS o en el servidor institucional.

## Trabajo sin Internet

Después de la primera carga/instalación, el Service Worker guarda la interfaz y las capas territoriales. El GPS del dispositivo puede obtener coordenadas sin Internet. Los registros y fotografías se guardan en IndexedDB y quedan pendientes de sincronización.

No se precargan de forma masiva las teselas de OpenStreetMap. Con conexión se presenta el mapa vial completo; sin conexión, la aplicación conserva las capas institucionales y dispone de un mapa vectorial simplificado como respaldo. Esta decisión evita convertir la PWA en un sistema de descarga masiva de mapas de terceros.

## Conexión con Google

La carpeta `apps-script/` contiene un backend de referencia. Para activarlo:

1. Crear o elegir una hoja de Google Sheets para los registros de la PWA.
2. Crear una carpeta de Google Drive para fotos.
3. Abrir un proyecto de Google Apps Script y pegar `apps-script/Code.gs`.
4. Reemplazar `SPREADSHEET_ID` y `DRIVE_FOLDER_ID`.
5. Desplegar como **Aplicación web** con la política de acceso que defina el GAD.
6. Copiar la URL terminada en `/exec`.
7. Pegarla en `config.js`, propiedad `syncEndpoint`.

El formulario Google existente puede seguir funcionando durante el piloto. La PWA no necesita "rellenar" Google Forms; es más robusto enviar directamente a Google Sheets/Drive mediante Apps Script.

## Pendientes antes de una versión institucional

- Validar en territorio los límites de barrios/parroquias y especialmente puntos ubicados junto a linderos.
- Definir si el campo de la matriz llamado **Frecuencia** debe mostrarse como frecuencia, nivel de acumulación u otro concepto.
- Incorporar logotipo, tipografía y colores oficiales.
- Definir la hoja/carpeta de Drive definitivas, la política de acceso del Web App y la validación de supervisor en el servidor.
- Decidir si los puntos inactivos/eliminados deben seguir visibles para consulta histórica.
- Resolver la coordenada pendiente del punto **SM1**.
- Realizar piloto en Android y iPhone antes de uso institucional general.


## Corrección v0.3.1
- Se corrigió la validación del PIN del piloto (1212).
- Se agregó indicador visible de versión.
- Se forzó renovación de caché para evitar mezclar archivos de versiones anteriores.
- Los archivos propios usan red primero y caché como respaldo offline.
