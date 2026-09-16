window.APP_CONFIG = {
  // Pegue aquí la URL del Web App de Google Apps Script cuando se habilite la sincronización.
  syncEndpoint: "",

  // Control de acceso del piloto. En v0.3.1 se valida directamente para evitar incompatibilidades de navegador/caché.
  // Antes de uso institucional público, la validación se trasladará al servidor de Google Apps Script.
  supervisorPin: "1212",
  supervisorPinHash: "cbfad02f9ed2a8d1e08d8f74f5303e9eb93637d47f82ab6f1c15871cf8dd0481",
  supervisorSessionHours: 8,

  // Nombre visible del sistema. La identidad gráfica es provisional hasta cargar logo/colores oficiales.
  organization: "Dirección de Higiene y Salubridad",
  appName: "Higiene Manta",
  version: "0.3.2"
};
