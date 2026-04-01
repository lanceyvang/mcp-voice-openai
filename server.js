import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const PORT = process.env.PORT || 8767;

const MODELS = [{
  id: 'gpt-realtime-1.5',
  name: 'GPT Realtime 1.5',
  provider: 'openai',
  voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'sage', 'shimmer', 'verse'],
  features: ['webrtc', 'vad'],
  notes: 'WebRTC SDP connection. Fallback key rotation.'
}];

async function createSession(apiKey, body) {
  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  return res.json();
}

function buildMcpServer() {
  const mcp = new McpServer({
    name: 'mcp-voice-openai',
    version: '1.0.0'
  });

  mcp.tool('list_models', 'List available OpenAI Realtime voice models and their supported voices', {}, async () => {
    return { content: [{ type: 'text', text: JSON.stringify(MODELS, null, 2) }] };
  });

  mcp.tool(
    'create_session',
    'Create an ephemeral OpenAI Realtime session with an API key for WebRTC connection',
    {
      bot_id: z.string().describe('Identifier for the bot requesting the session'),
      instructions: z.string().describe('System instructions for the realtime session'),
      tools_schema: z.array(z.any()).describe('Array of tool definitions for the session'),
      voice: z.string().optional().describe('Voice to use (default: marin)')
    },
    async ({ bot_id, instructions, tools_schema, voice }) => {
      const selectedVoice = voice || 'marin';
      const body = {
        model: 'gpt-realtime-1.5',
        voice: selectedVoice,
        instructions,
        tools: tools_schema,
        modalities: ['text', 'audio']
      };

      const primaryKey = process.env.OPENAI_API_KEY;
      const fallbackKey = process.env.OPENAI_API_KEY_FALLBACK;

      let data;
      try {
        data = await createSession(primaryKey, body);
      } catch (err) {
        if (fallbackKey) {
          console.error(`Primary key failed for ${bot_id}: ${err.message}. Trying fallback.`);
          data = await createSession(fallbackKey, body);
        } else {
          throw err;
        }
      }

      const result = {
        provider: 'openai',
        model: 'gpt-realtime-1.5',
        ephemeralKey: data.client_secret?.value,
        sessionConfig: {
          voice: selectedVoice,
          modalities: ['text', 'audio']
        }
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return mcp;
}

const app = express();

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'mcp-voice-openai' });
});

// SSE endpoint — one transport per connection
const transports = {};

app.get('/sse', async (req, res) => {
  const mcp = buildMcpServer();
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = { transport, mcp };

  res.on('close', () => {
    delete transports[transport.sessionId];
    mcp.close();
  });

  await mcp.connect(transport);
});

app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = transports[sessionId];
  if (!entry) {
    res.status(400).json({ error: 'Unknown session' });
    return;
  }
  await entry.transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`mcp-voice-openai listening on port ${PORT}`);
  console.log(`  SSE:     http://localhost:${PORT}/sse`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
});
