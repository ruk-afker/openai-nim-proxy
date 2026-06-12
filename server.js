// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false;

// 🔥 THINKING MODE TOGGLE
const ENABLE_THINKING_MODE = false;

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': process.env.MODEL_SMALL  || 'z-ai/glm-5.1',
  'gpt-4':         process.env.MODEL_MID    || 'moonshotai/kimi-k2.6',
  'gpt-4-turbo':   process.env.MODEL_LARGE  || 'deepseek-ai/deepseek-v4-pro',
  'gpt-4o':        process.env.MODEL_BEST   || 'mistralai/mistral-large-3-675b-instruct-2512',
  'claude-3-opus': process.env.MODEL_ALT    || 'deepseek-ai/deepseek-v4-flash',
  'o1':            process.env.MODEL_REASON || 'nvidia/nemotron-3-super-120b',
};

// Keep-alive ping to prevent Render free tier sleep
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/health`);
      console.log('Keep-alive ping sent');
    } catch (e) {
      console.log('Keep-alive failed:', e.message);
    }
  }, 10 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

// Retry helper for 429/504 errors
async function nimRequestWithRetry(payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(
        `${NIM_API_BASE}/chat/completions`,
        payload,
        { headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      return response;
    } catch (error) {
      const status = error.response?.status;
      if ((status === 429 || status === 504) && i < retries - 1) {
        const wait = Math.pow(2, i) * 1000;
        console.log(`Error ${status}, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw error;
      }
    }
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// Live models endpoint — fetches directly from NVIDIA
app.get('/v1/models', async (req, res) => {
  try {
    const response = await axios.get(`${NIM_API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}` }
    });

    const liveModels = response.data.data || [];
    const aliasModels = Object.keys(MODEL_MAPPING).map(model => ({
      id: model,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy',
      mapped_to: MODEL_MAPPING[model]
    }));

    const allIds = new Set(liveModels.map(m => m.id));
    const uniqueAliases = aliasModels.filter(m => !allIds.has(m.id));

    res.json({ object: 'list', data: [...liveModels, ...uniqueAliases] });
  } catch (error) {
    console.error('Failed to fetch live models:', error.message);
    const fallback = Object.keys(MODEL_MAPPING).map(model => ({
      id: model,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }));
    res.json({ object: 'list', data: fallback });
  }
});

// Chat completions — main proxy
app.post('/v1/chat/completions', async (req, res) => {
  try {
    let { model, messages, temperature, max_tokens, stream } = req.body;

    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        const testRes = await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: s => s < 500
        });
        if (testRes.status >= 200 && testRes.status < 300) nimModel = model;
      } catch (e) {}

      if (!nimModel) {
        const ml = model.toLowerCase();
        if (ml.includes('gpt-4') || ml.includes('claude-opus') || ml.includes('405b')) {
          nimModel = 'meta/llama-3.3-70b-instruct';
        } else if (ml.includes('claude') || ml.includes('gemini') || ml.includes('70b')) {
          nimModel = 'nvidia/llama-3.3-nemotron-super-49b-v1';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }

    // In your chat completions handler, add this before building nimRequest
if (nimModel.includes('glm')) {
  const hasSystem = messages.some(m => m.role === 'system');
  
  if (hasSystem) {
    // Append to existing system prompt
    messages = messages.map(m => 
      m.role === 'system' 
        ? { ...m, content: m.content + '\n\nALWAYS format your responses with proper paragraph breaks and spacing. Never write in walls of text. Each new idea or beat gets its own paragraph.' }
        : m
    );
  } else {
    // Inject a new system message
    messages = [
      { role: 'system', content: 'ALWAYS format your responses with proper paragraph breaks and spacing. Never write in walls of text. Each new idea or beat gets its own paragraph.' },
      ...messages
    ];
  }
}
    
    // Build NIM request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      stream: stream || false,
      ...(nimModel.includes('deepseek-v4') && {
  chat_template_kwargs: { 
    enable_thinking: true,
    thinking: false  // 👈 Change this to false for speed
  }
}),
      // Optional thinking mode for other models
      ...(ENABLE_THINKING_MODE && !nimModel.includes('deepseek-v4') && {
        extra_body: { chat_template_kwargs: { thinking: true } }
      })
    };

    if (stream) {
      const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
        responseType: 'stream'
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          if (line.includes('[DONE]')) { res.write(line + '\n'); return; }

          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta) {
              const reasoning = data.choices[0].delta.reasoning_content;
              const content = data.choices[0].delta.content;

              if (SHOW_REASONING) {
                let combined = '';
                if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
                else if (reasoning) { combined = reasoning; }
                if (content && reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
                else if (content) { combined += content; }
                if (combined) { data.choices[0].delta.content = combined; }
              } else {
                data.choices[0].delta.content = content || '';
              }
              delete data.choices[0].delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            res.write(line + '\n');
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', err => { console.error('Stream error:', err); res.end(); });

    } else {
      const response = await nimRequestWithRetry(nimRequest);

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            content = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + content;
          
          }

          if (idx === 0 && SHOW_MODEL_TAG) {
            content = `[Model: ${usedModel}]\n\n` + content;
          }
          
          return {
            index: choice.index,
            message: { role: choice.message.role, content },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// 404 catch-all
app.all('*', (req, res) => {
  res.status(404).json({
    error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 }
  });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
