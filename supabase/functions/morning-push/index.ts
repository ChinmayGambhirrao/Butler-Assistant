import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webPush from 'npm:web-push'

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const nvidiaApiKey = Deno.env.get('NVIDIA_API_KEY')!
    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!

    webPush.setVapidDetails(
      'mailto:butler@assistant.app',
      vapidPublicKey,
      vapidPrivateKey,
    )

    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('*')

    if (!subscriptions || subscriptions.length === 0) {
      return new Response('No subscribers', { status: 200 })
    }

    for (const sub of subscriptions) {
      const { data: tasks } = await supabase
        .from('tasks')
        .select('text, category, due_date')
        .eq('user_id', sub.user_id)
        .eq('completed', false)
        .order('created_at', { ascending: true })

      const pendingText = tasks && tasks.length > 0
        ? tasks.map(t => `${t.text} (${t.category})`).join(', ')
        : 'No pending tasks'

      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nvidiaApiKey}`,
        },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            {
              role: 'system',
              content: 'You are a personal butler assistant. Greet the user warmly as "sir". Give a 2-3 sentence morning briefing of what tasks are pending today. Be warm, conversational, and encouraging. Output ONLY the message text, no JSON.',
            },
            {
              role: 'user',
              content: `Today's pending tasks: ${pendingText}`,
            },
          ],
          temperature: 0.7,
          max_tokens: 150,
        }),
      })

      const data = await response.json()
      const briefing = data.choices?.[0]?.message?.content || 'Good morning sir! Have a wonderful day.'

      await webPush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title: '🕴️ Morning Briefing',
          body: briefing.slice(0, 200),
        }),
      ).catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          supabase.from('push_subscriptions').delete().eq('id', sub.id)
        }
      })
    }

    return new Response('Notifications sent', { status: 200 })
  } catch (err) {
    return new Response(err.message, { status: 500 })
  }
})
