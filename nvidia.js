import { config } from './config.js';
import { formatHistoryForPrompt } from './history.js';
import { characters, formatCharactersForPrompt } from './characters.js';

// Timeout en ms para la llamada a la API
const API_TIMEOUT_MS = 5_000;

// Reintentos automáticos ante errores 5xx o fallos de red (por modelo)
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

/**
 * Lista de modelos de respaldo ordenados por preferencia.
 * Si el modelo configurado en .env falla, se probarán estos en orden.
 * Nombres oficiales del catálogo NVIDIA NIM.
 */
const FALLBACK_MODELS = [
  // Modelos que funcionan con API key gratuita
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'deepseek-ai/deepseek-v4-flash',
  'z-ai/glm-5.2'
];

/**
 * Extrae el primer objeto JSON válido de un texto libre contando llaves.
 * Más robusto que un regex non-greedy para JSON anidado.
 */
function extractJSON(text) {
  // Limpieza previa de posibles tags de razonamiento (ej: DeepSeek o Nemotron Reasoning)
  const cleanText = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();

  const start = cleanText.indexOf('{');
  if (start === -1) {
    console.warn('[nvidia] No se encontró ningún bloque JSON en la respuesta.');
    return null;
  }

  let depth = 0;
  let end = -1;
  for (let i = start; i < cleanText.length; i++) {
    if (cleanText[i] === '{') depth++;
    else if (cleanText[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) {
    console.warn('[nvidia] JSON incompleto: llaves no balanceadas.');
    return null;
  }

  try {
    const parsed = JSON.parse(cleanText.slice(start, end + 1));
    console.log('[nvidia] JSON extraído correctamente.');
    return parsed;
  } catch (err) {
    console.warn('[nvidia] JSON encontrado pero falló el parseo:', err.message);
    return null;
  }
}

/**
 * Construye el array de mensajes (system + few-shot + real context) para enviar a la API.
 */
function buildMessages(forceCharacter, replyToAuthor) {
  const systemInstruction = `Sos el director de un chat de Discord con personajes ficticios.
Debes responder única y exclusivamente con un objeto JSON que contenga las claves "character", "message" y "replyTo".
REGLAS ESTRICTAS PARA "replyTo":
- El 90% de los mensajes deben tener "replyTo": null. Los personajes hablan al canal en general, no le hablan directamente a alguien.
- Solo usas "replyTo" con un nombre cuando el personaje LE ESTÁ RESPONDIENDO DIRECTAMENTE a esa persona (porque le hicieron una pregunta directa, le pidieron opinión, etc.).
- Si no estás seguro, pon "replyTo": null. Es mejor no mencionar que mencionar innecesariamente.
- NUNCA menciones al usuario en cada mensaje. En una conversación real de Discord la gente no se @mentionea constantemente.
Ejemplos correctos:
{"character": "Spider-Man", "message": "jaja que buen tema", "replyTo": null}
{"character": "Tony Stark", "message": "alguien pidio mi opinion? no, verdad?", "replyTo": null}
{"character": "Spider-Man", "message": "a mi me gusta esa canción", "replyTo": "pinkfloiii"}

No agregues texto antes ni después del JSON. No uses markdown. No expliques nada.`;

  const historyText = formatHistoryForPrompt();
  const charactersText = formatCharactersForPrompt();
  const characterNames = characters.map((c) => c.name).join(', ');

  let forceInstruction = '';
  if (forceCharacter) {
    forceInstruction = `Debes elegir OBLIGATORIAMENTE al personaje "${forceCharacter}" para que responda.`;
    if (replyToAuthor) {
      forceInstruction += ` El último mensaje fue de "${replyToAuthor}", pero NO tienes que mencionarlo. El personaje habla al canal en general a menos que el contexto EXIJA una respuesta directa. Por defecto pon "replyTo": null.`;
    }
  } else {
    forceInstruction = `Elige uno de los personajes (${characterNames}) de forma lógica. Por defecto "replyTo": null. Solo usa "replyTo" con un nombre si es ESTRICTAMENTE necesario (pregunta directa, mención explícita en el historial).`;
  }

  return [
    {
      role: 'system',
      content: systemInstruction
    },
    {
      role: 'user',
      content: `eres el director de un chat de Discord con personajes ficticios.
Debes responder única y exclusivamente con un objeto JSON que contenga las claves "character", "message" y "replyTo".

Las respuestas deben ser casuales y naturales para chat de Discord, de longitud moderada (típicamente 1 o 2 oraciones, de entre 5 y 20 palabras). Evita textos extremadamente largos o párrafos formales.

Personajes disponibles:
- Spider-Man: Peter Parker. Joven, sarcástico.
- Tony Stark: Genio, millonario, ego.

Historial del chat:
[2026-07-10T09:40:00.000Z] pinkfloiii (respondiendo a Spider-Man): que onda
[2026-07-10T09:40:02.000Z] pinkfloiii: hace frio`
    },
    {
      role: 'assistant',
      content: `{"character": "Spider-Man", "message": "lit, me estoy congelando las patas", "replyTo": null}`
    },
    {
      role: 'user',
      content: `Excelente. Ahora hazlo para esta situación real:

Personajes disponibles:
${charactersText}

Historial del chat:
${historyText}

${forceInstruction} Responde únicamente con el JSON. Recuerda: la respuesta debe ser corta y casual (máx. 20 palabras), fluida y seguir estrictamente el 'Estilo de escritura' de ortografía y puntuación indicado para ese personaje.`
    }
  ];
}

/**
 * Intenta obtener una respuesta de un modelo específico de NVIDIA.
 * @param {string} modelName - Nombre del modelo (ej: "deepseek-ai/deepseek-r1")
 * @param {Array} messages - Array de mensajes estilo OpenAI
 * @param {number} startTime - Timestamp de inicio para medir tiempos
 * @returns {Promise<{character: string, message: string, replyTo: string|null}|null>}
 */
async function tryModel(modelName, messages, startTime) {
  console.log(`[nvidia] Intentando modelo: ${modelName}`);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      console.log(`[nvidia] Reintentando ${modelName} en ${RETRY_DELAY_MS / 1000}s... (intento ${attempt}/${MAX_RETRIES + 1})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const response = await Promise.race([
        fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.nvidia.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: messages,
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1024
          }),
          signal: controller.signal
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout tras ${API_TIMEOUT_MS / 1000}s`)), API_TIMEOUT_MS)
        )
      ]);

      clearTimeout(timeoutId);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API responded with status ${response.status} ${response.statusText}: ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() || '';

      console.log(`[nvidia] Respuesta de ${modelName} recibida en ${elapsed}s (${text.length} chars).`);
      console.log(`[nvidia] Raw limpio: ${text.substring(0, 300)}${text.length > 300 ? '...' : ''}`);

      const parsed = extractJSON(text);

      if (!parsed?.character || !parsed?.message) {
        console.error(`[nvidia] [${modelName}] Faltan campos "character" o "message" en el JSON parseado.`);
        console.error(`[nvidia] [${modelName}] Objeto parseado:`, JSON.stringify(parsed));
        return null;
      }

      // Guardia anti-placeholder: detecta si el modelo devolvió el template literal
      const isTemplateLiteral =
        parsed.character?.includes('<') ||
        parsed.message?.includes('<') ||
        parsed.character === 'NOMBRE_DEL_PERSONAJE' ||
        parsed.message === 'TEXTO_DEL_MENSAJE';

      if (isTemplateLiteral) {
        console.error(`[nvidia] [${modelName}] El modelo devolvió el template sin rellenar. Descartando.`);
        return null;
      }

      console.log(`[nvidia] [${modelName}] ✓ Personaje: "${parsed.character}" | Mensaje: "${parsed.message.substring(0, 80)}" | ReplyTo: ${parsed.replyTo || 'ninguno'}`);
      return parsed;

    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const isTransient = err.message.includes('500') || err.message.includes('503') || err.message.includes('Internal error') || err.message.includes('Timeout') || err.name === 'AbortError';

      if (isTransient && attempt <= MAX_RETRIES) {
        console.warn(`[nvidia] [${modelName}] Error transitorio tras ${elapsed}s (intento ${attempt}): ${err.message}`);
      } else {
        console.error(`[nvidia] [${modelName}] Error definitivo tras ${elapsed}s: ${err.message}`);
        return null; // Modelo agotó sus reintentos
      }
    }
  }

  return null;
}

/**
 * Realiza una llamada a la API de NVIDIA con fallback automático entre modelos.
 * Primero prueba el modelo configurado en .env (NVIDIA_MODEL).
 * Si falla, prueba los modelos de FALLBACK_MODELS en orden hasta que uno funcione.
 *
 * @param {string|null} forceCharacter - Nombre del personaje a forzar (si lo hay)
 * @param {string|null} replyToAuthor - Nombre del usuario/personaje al que se está respondiendo (si lo hay)
 * @returns {Promise<{character: string, message: string, replyTo: string|null}|null>}
 */
export async function askNvidia(forceCharacter = null, replyToAuthor = null) {
  const messages = buildMessages(forceCharacter, replyToAuthor);
  const startTime = Date.now();

  // Modelos probados con API key gratuita (sin 8B, causa loops):
  // 1. 49B Nemotron Super: coherente, ~4s
  // 2. DeepSeek Flash: ~2-4s
  // 3. GLM-5.2: ~8s, respaldo
  const modelsToTry = [
    'nvidia/llama-3.3-nemotron-super-49b-v1',
    'deepseek-ai/deepseek-v4-flash',
    'z-ai/glm-5.2'
  ];

  for (const model of modelsToTry) {
    console.log(`[nvidia] Intentando modelo: ${model}`);
    const result = await tryModel(model, messages, startTime);
    if (result) {
      console.log(`[nvidia] ✓ Respuesta exitosa con modelo: ${model}`);
      return result;
    }
  }

  // Todos los modelos fallaron
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[nvidia] Todos los modelos agotados tras ${totalElapsed}s. No se pudo obtener respuesta.`);
  return null;
}