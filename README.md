# discord-character-bot

Bot de Discord donde personajes ficticios interactuan entre si y con los usuarios usando la API de NVIDIA NIM. Arquitectura minimalista: una sola llamada a NVIDIA por respuesta con fallback automatico entre modelos.

---

## Estado de modelos NVIDIA en produccion

Tras pruebas en produccion, estos son los modelos verificados que funcionan actualmente en el catalogo de NVIDIA:

| Modelo | Estado | Notas |
|--------|--------|-------|
| minimaxai/minimax-m3 | Funciona | Respuestas rapidas (~3-10s), alta confiabilidad |
| meta/llama-3.3-70b-instruct | Funciona | Lento (~70s) pero util como ultimo recurso |
| deepseek-ai/deepseek-v4-flash | Inestable | Devuelve 503 (ResourceExhausted) frecuentemente |
| deepseek-ai/deepseek-v4 | No existe | Devuelve 404, eliminado del catalogo |

La configuracion de fallback prioriza minimaxai/minimax-m3 por su velocidad y confiabilidad.

---

## Estructura del proyecto

```
├── index.js         # Entry point: cliente Discord, listener de mensajes
├── config.js        # Carga y valida variables de entorno
├── characters.js    # Registro de personajes (nombre, descripcion, avatar, webhook)
├── history.js       # Historial circular de mensajes recientes
├── nvidia.js        # Llamada a NVIDIA NIM con fallback entre modelos
├── responder.js     # Logica de probabilidad, limite de auto-respuestas, envio por webhook
├── .env             # Variables de entorno (no commitear)
└── .env.example     # Plantilla de variables
```

---

## Configuracion inicial

### 1. Instalar dependencias

```bash
npm install
```

### 2. Crear el archivo `.env`

Copia `.env.example` a `.env` y rellena los valores:

```env
DISCORD_TOKEN=tu_token_aqui
DISCORD_CHANNEL_ID=123456789012345678
NVIDIA_API_KEY=tu_api_key_aqui
NVIDIA_MODEL=minimaxai/minimax-m3

RESPONSE_PROBABILITY=0.67
MAX_AUTO_RESPONSES=4
HISTORY_SIZE=50
```

Se recomienda usar `minimaxai/minimax-m3` como modelo primario por su velocidad y confiabilidad.

### 3. Crear webhooks en Discord

Por cada personaje, crea un webhook en el canal:
- Discord -> Canal -> Editar canal -> Integraciones -> Webhooks -> Crear webhook
- Ponle el nombre del personaje
- Copia la URL del webhook

### 4. Agregar webhooks al `.env`

```env
WEBHOOK_SPIDER_MAN=https://discord.com/api/webhooks/...
WEBHOOK_TONY_STARK=https://discord.com/api/webhooks/...
WEBHOOK_SAUL_GOODMAN=https://discord.com/api/webhooks/...
WEBHOOK_L_LAWLIET=https://discord.com/api/webhooks/...
WEBHOOK_WALTER_WHITE=https://discord.com/api/webhooks/...
```

### 5. Actualizar avatares en `characters.js`

Reemplaza las URLs de `avatar` con imagenes reales accesibles publicamente (Imgur, CDN, etc.).

### 6. Habilitar el intent de contenido de mensajes

En el [Portal de Desarrolladores de Discord](https://discord.com/developers/applications):
- Tu aplicacion -> Bot -> Message Content Intent -> Activar

---

## Arrancar el bot

```bash
npm start
# o en modo watch (reinicia al guardar):
npm run dev
```

---

## Agregar un nuevo personaje

1. Crea el webhook en Discord y copia la URL.
2. Anade la URL al `.env`:
   ```env
   WEBHOOK_NOMBRE=https://discord.com/api/webhooks/...
   ```
3. Agrega la entrada en `characters.js`:
   ```js
   {
     name: 'Nombre del personaje',
     description: 'Descripcion de su personalidad y forma de hablar.',
     avatar: 'https://url-de-su-imagen.png',
     webhookUrl: process.env.WEBHOOK_NOMBRE ?? '',
   }
   ```
4. Reinicia el bot. Listo.

---

## Parametros configurables

| Variable               | Descripcion                                             | Default                |
|------------------------|---------------------------------------------------------|------------------------|
| `RESPONSE_PROBABILITY` | Probabilidad de responder (0.0 - 1.0)                   | `0.45` (45%)           |
| `MAX_AUTO_RESPONSES`   | Respuestas automaticas consecutivas antes de silenciarse | `4`                    |
| `HISTORY_SIZE`         | Mensajes maximos en el historial de contexto            | `15`                   |
| `NVIDIA_MODEL`         | Modelo de NVIDIA NIM a usar                             | `meta/llama-3.1-8b-instruct` |

---

## Flujo de mensajes

```
mensaje llega al canal
        │
        ▼
es del canal correcto?  -> No -> ignorar
        │ Si
        ▼
agregar al historial
        │
        ▼
es humano?  -> Si -> resetear contador de auto-respuestas
        │
        ▼
consecutivas >= MAX_AUTO_RESPONSES?  -> Si -> no responder
        │ No
        ▼
tirada aleatoria <= RESPONSE_PROBABILITY?  -> No -> no responder
        │ Si
        ▼
llamada a NVIDIA (historial + personajes + instrucciones)
        │
        ▼
NVIDIA devuelve { character, message }
        │
        ▼
buscar webhook del personaje
        │
        ▼
enviar mensaje via webhook
        │
        ▼
webhook dispara messageCreate -> mismo flujo