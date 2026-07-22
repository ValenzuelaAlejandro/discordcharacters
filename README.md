# discord-character-bot

Bot de Discord donde personajes ficticios interactúan entre sí y con los usuarios usando la API de NVIDIA. Arquitectura minimalista, una sola llamada a NVIDIA por respuesta.

---

## Estructura del proyecto

```
├── index.js         # Entry point: cliente Discord, listener de mensajes
├── config.js        # Carga y valida variables de entorno
├── characters.js    # Registro de personajes (nombre, descripción, avatar, webhook)
├── history.js       # Historial circular de mensajes recientes
├── nvidia.js        # Una llamada a NVIDIA → { character, message }
├── responder.js     # Lógica de probabilidad, límite de auto-respuestas, envío por webhook
├── .env             # Variables de entorno (no commitear)
└── .env.example     # Plantilla de variables
```

---

## Configuración inicial

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
NVIDIA_MODEL=meta/llama-3.1-8b-instruct

RESPONSE_PROBABILITY=0.45
MAX_AUTO_RESPONSES=4
HISTORY_SIZE=15
```

### 3. Crear webhooks en Discord

Por cada personaje, crea un webhook en el canal:
- Discord → Canal → Editar canal → Integraciones → Webhooks → Crear webhook
- Ponle el nombre del personaje
- Copia la URL del webhook

### 4. Agregar webhooks al `.env`

```env
WEBHOOK_SPIDER_MAN=https://discord.com/api/webhooks/...
WEBHOOK_SHERLOCK=https://discord.com/api/webhooks/...
WEBHOOK_HERMIONE=https://discord.com/api/webhooks/...
WEBHOOK_TONY_STARK=https://discord.com/api/webhooks/...
```

### 5. Actualizar avatares en `characters.js`

Reemplaza las URLs de `avatar` con imágenes reales accesibles públicamente (Imgur, CDN, etc.).

### 6. Habilitar el intent de contenido de mensajes

En el [Portal de Desarrolladores de Discord](https://discord.com/developers/applications):
- Tu aplicación → Bot → Message Content Intent → **Activar**

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
2. Añade la URL al `.env`:
   ```env
   WEBHOOK_NOMBRE=https://discord.com/api/webhooks/...
   ```
3. Agrega la entrada en `characters.js`:
   ```js
   {
     name: 'Nombre del personaje',
     description: 'Descripción de su personalidad y forma de hablar.',
     avatar: 'https://url-de-su-imagen.png',
     webhookUrl: process.env.WEBHOOK_NOMBRE ?? '',
   }
   ```
4. Reinicia el bot. Listo.

---

## Parámetros configurables

| Variable               | Descripción                                             | Default          |
|------------------------|---------------------------------------------------------|------------------|
| `RESPONSE_PROBABILITY` | Probabilidad de responder (0.0 - 1.0)                   | `0.45` (45%)     |
| `MAX_AUTO_RESPONSES`   | Respuestas automáticas consecutivas antes de silenciarse| `4`              |
| `HISTORY_SIZE`         | Mensajes máximos en el historial de contexto            | `15`             |
| `NVIDIA_MODEL`         | Modelo de NVIDIA a usar                                 | `meta/llama-3.1-8b-instruct` |

---

## Flujo de mensajes

```
mensaje llega al canal
        │
        ▼
¿es del canal correcto?  → No → ignorar
        │ Sí
        ▼
agregar al historial
        │
        ▼
¿es humano?  → Sí → resetear contador de auto-respuestas
        │
        ▼
¿consecutivas >= MAX_AUTO_RESPONSES?  → Sí → no responder
        │ No
        ▼
tirada aleatoria <= RESPONSE_PROBABILITY?  → No → no responder
        │ Sí
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
enviar mensaje vía webhook
        │
        ▼
webhook dispara messageCreate → mismo flujo
```
