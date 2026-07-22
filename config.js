import 'dotenv/config';

/**
 * Configuración central del bot.
 * Todos los valores sensibles o ajustables vienen del archivo .env
 */
export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    webhookUrl: process.env.WEBHOOK_URL,
  },
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY,
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',
  },
  bot: {
    // Probabilidad de que el bot responda a cualquier mensaje (0.0 - 1.0)
    responseProbability: parseFloat(process.env.RESPONSE_PROBABILITY ?? '0.45'),
    // Cuántas respuestas automáticas consecutivas se permiten antes de silenciar
    maxAutoResponses: parseInt(process.env.MAX_AUTO_RESPONSES ?? '4', 10),
    // Cuántos mensajes mantener en el historial de contexto
    historySize: parseInt(process.env.HISTORY_SIZE ?? '15', 10),
  },
};

// Validación mínima al arrancar
const required = [
  ['DISCORD_TOKEN', config.discord.token],
  ['DISCORD_CHANNEL_ID', config.discord.channelId],
  ['WEBHOOK_URL', config.discord.webhookUrl],
  ['NVIDIA_API_KEY', config.nvidia.apiKey],
];

for (const [name, value] of required) {
  if (!value) {
    console.error(`[config] ERROR: La variable de entorno ${name} es requerida.`);
    process.exit(1);
  }
}
