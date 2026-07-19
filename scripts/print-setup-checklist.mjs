const envGroups = [
  {
    title: 'Frontend public runtime',
    keys: [
      ['VITE_SUPABASE_URL', true],
      ['VITE_SUPABASE_ANON_KEY', true],
      ['GITHUB_PAGES_BASE', false],
    ],
  },
  {
    title: 'Supabase deployment',
    keys: [
      ['SUPABASE_PROJECT_REF', true],
      ['SUPABASE_ACCESS_TOKEN', true],
      ['GITHUB_TOKEN', false],
    ],
  },
  {
    title: 'Supabase Edge Function secrets',
    keys: [
      ['SUPABASE_URL', true],
      ['SUPABASE_SERVICE_ROLE_KEY', true],
      ['TELEGRAM_ADMIN_BOT_TOKEN', true],
      ['TELEGRAM_ADMIN_CHAT_ID', true],
      ['TELEGRAM_WEBHOOK_URL', true],
      ['TELEGRAM_WEBHOOK_SECRET', true],
      ['TRACKING_EVENT_SECRET', true],
      ['TELEGRAM_TRACKING_BASE_URL', false],
      ['PLATFORM_FUNCTION_URL', false],
    ],
  },
  {
    title: 'Future AI providers',
    keys: [
      ['OPENAI_API_KEY', false],
      ['ANTHROPIC_API_KEY', false],
      ['QWEN_API_KEY', false],
    ],
  },
  {
    title: 'Future social/workflow providers',
    keys: [
      ['X_CLIENT_ID', false],
      ['X_CLIENT_SECRET', false],
      ['X_REDIRECT_URI', false],
      ['COMFYUI_BASE_URL', false],
      ['COMFYUI_API_KEY', false],
      ['RUNNINGHUB_BASE_URL', false],
      ['RUNNINGHUB_API_KEY', false],
    ],
  },
];

console.log('AI Marketing Studio setup checklist\n');

for (const group of envGroups) {
  console.log(group.title);
  for (const [key, required] of group.keys) {
    const status = process.env[key] ? 'configured' : required ? 'missing required' : 'missing optional';
    console.log(`${key}: ${status}`);
  }
  console.log('');
}

console.log('Next actions:');
console.log('1. Create a Supabase project from the Supabase dashboard.');
console.log('2. Run Supabase migrations 202607190001, 202607190002, 202607190003, 202607190004, 20260719081338, 20260719082436, 20260719083243, 20260719083854, 20260719085024, 20260719085554, 20260719090441, 20260719091213, 20260719092038, 20260719093509, 20260719094321, and 20260719104342 in order.');
console.log('3. Enable Google provider in Supabase Auth if Google sign-in is used.');
console.log('4. Add GitHub repository secrets: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
console.log('5. Add Edge Function secrets with supabase secrets set; never expose service role or provider tokens in frontend.');
console.log('6. Deploy the platform Edge Function and configure the Telegram webhook.');
console.log('7. Push to main to deploy GitHub Pages.');
