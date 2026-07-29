import { config } from './config.js';
import { formatHistoryForPrompt } from './history.js';
import { characters, formatCharactersForPrompt } from './characters.js';

// Timeout en ms para la llamada a la API
const API_TIMEOUT_MS = 20_000;

// Reintentos automáticos ante errores transitorios
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

/**
 * Modelos en orden de prioridad.
 * Se prueba cada uno; si falla pasa al siguiente.
 */
const MODELS = [
  'nvidia/llama-3.3-nemotron-super-49b-v1',  // ~4s, coherente
  'deepseek-ai/deepseek-v4-flash',             // ~2-4s
  'z-ai/glm-5.2'                               // ~8s, respaldo
];

/**
 * Extrae el primer objeto JSON válido de un texto libre contando llaves.
 */
function extractJSON(text) {
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
  const systemInstruction = `Eres el director de un chat de Discord con personajes ficticios. Tu trabajo es elegir qué personaje responde y qué dice, como si fueran personas reales conversando.

Debes responder ÚNICA y EXCLUSIVAMENTE con un objeto JSON con las claves "character", "message" y "replyTo".

REGLAS PARA "replyTo":
- 90% de las veces debe ser null. Los personajes hablan al canal en general.
- Solo usa "replyTo" con un nombre cuando el personaje LE RESPONDE DIRECTAMENTE a esa persona (pregunta directa, mención explícita).
- Si no estás seguro, pon null.

REGLAS DE NATURALIDAD:
- Cada personaje debe sonar como UNA PERSONA REAL. Lee su descripción en "Personajes disponibles" para saber cómo habla, pero sin exagerar ni caer en clichés.
- No uses frases hechas ni muletillas predecibles. El personaje debe expresarse con naturalidad, no sonar a cita de manual.
- Variedad de longitud: mensajes cortos (3-8 palabras) y otros más elaborados (1-2 oraciones). Alterna naturalmente.
- Si un personaje ya habló hace poco, elige a OTRO para variar.
- No repitas mensajes idénticos ni el mismo contenido reformulado.

Ejemplos de respuestas (la personalidad de cada personaje define el tono):
{"character": "Spider-Man", "message": "jaja no mames, q buen chiste", "replyTo": null}
{"character": "Tony Stark", "message": "interesante punto, pero creo que estas subestimando el factor humano", "replyTo": null}
{"character": "Spider-Man", "message": "a mi me gusta esa canción, la tengo en mi playlist", "replyTo": "pinkfloiii"}

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
      content: `Eres el director de un chat de Discord con personajes ficticios.
Debes responder única y exclusivamente con un objeto JSON que contenga las claves "character", "message" y "replyTo".

Las respuestas deben sonar naturales, como personas reales conversando en Discord. La longitud debe variar: a veces una palabra, a veces dos oraciones. No hay un límite fijo.

Personajes disponibles:
- Spider-Man: Peter Parker. Joven, sarcástico, escribe en minúsculas.
- Tony Stark: Genio, millonario, sarcástico e ingenioso.

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

${forceInstruction} Responde únicamente con el JSON. Recuerda: la respuesta debe sonar natural, como si el personaje fuera una persona real escribiendo en Discord. Sigue el estilo de escritura indicado para ese personaje pero sin exagerar.`
    }
  ];
}

/**
 * Intenta obtener una respuesta de un modelo específico de NVIDIA.
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
            temperature: 0.85,
            top_p: 0.9,
            max_tokens: 1024,
            frequency_penalty: 0.4,
            presence_penalty: 0.4
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

      // Guardia anti-placeholder
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
        return null;
      }
    }
  }

  return null;
}

/**
 * Prueba los modelos en orden hasta que uno responda.
 *
 * @param {string|null} forceCharacter - Personaje a forzar
 * @param {string|null} replyToAuthor - Usuario al que se responde
 * @returns {Promise<{character: string, message: string, replyTo: string|null}|null>}
 */
export async function askNvidia(forceCharacter = null, replyToAuthor = null) {
  const messages = buildMessages(forceCharacter, replyToAuthor);
  const startTime = Date.now();

  for (const model of MODELS) {
    console.log(`[nvidia] Intentando modelo: ${model}`);
    const result = await tryModel(model, messages, startTime);
    if (result) {
      console.log(`[nvidia] ✓ Respuesta exitosa con modelo: ${model}`);
      return result;
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[nvidia] Todos los modelos agotados tras ${totalElapsed}s.`);
  return null;
}