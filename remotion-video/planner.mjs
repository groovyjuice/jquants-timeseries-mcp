import OpenAI from 'openai';

const sceneSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenes: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: {type: 'string'},
          body: {type: 'string'},
          emotion: {
            type: 'string',
            enum: ['normal', 'surprise', 'serious'],
          },
          visualPrompt: {type: 'string'},
        },
        required: ['title', 'body', 'emotion', 'visualPrompt'],
      },
    },
  },
  required: ['scenes'],
};

const toRemotionProps = (planned) => ({
  scenes: planned.scenes.map((scene, index) => ({
    from: index * 300,
    duration: 300,
    title: scene.title,
    body: scene.body,
    emotion: scene.emotion,
    visualPrompt: scene.visualPrompt,
  })),
});

export const planScenes = async (script) => {
  if (typeof script !== 'string' || script.trim().length === 0) {
    throw new Error('script must be a non-empty string');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';

  const response = await client.responses.create({
    model,
    reasoning: {effort: 'low'},
    instructions: [
      'You are a scene planner for a Japanese financial-news YouTube video.',
      'For this prototype, split the supplied script into exactly 3 scenes.',
      'Do not add financial facts, prices, dates, company claims, or statistics that are not in the input.',
      'Keep each body concise and faithful to the supplied script.',
      'Choose emotion from normal, surprise, serious.',
      'visualPrompt is for a 16:9 background/slide visual.',
      'Do not put text, numbers, logos, stock prices, or factual labels inside visualPrompt.',
      'The Remotion layer will add accurate text separately.',
    ].join(' '),
    input: script.trim(),
    text: {
      format: {
        type: 'json_schema',
        name: 'youtube_scene_plan',
        strict: true,
        schema: sceneSchema,
      },
    },
  });

  const planned = JSON.parse(response.output_text);
  return {
    model,
    planned,
    props: toRemotionProps(planned),
  };
};
