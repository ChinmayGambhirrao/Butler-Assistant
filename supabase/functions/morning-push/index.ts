import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webPush from 'npm:web-push'

function buildMorningBriefing(tasks: Array<{ text: string; category: string; due_date?: string | null; priority?: string; completed?: boolean }>) {
  const pending = (tasks || []).filter(task => !task.completed)
  if (pending.length === 0) {
    return 'Good morning sir. Your day is beautifully clear and your schedule is calm.'
  }

  const dueToday = pending.filter(task => task.due_date === new Date().toISOString().slice(0, 10))
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
  const topTasks = [...pending]
    .sort((a, b) => {
      const priorityDiff = (priorityOrder[a.priority || 'medium'] ?? 1) - (priorityOrder[b.priority || 'medium'] ?? 1)
      if (priorityDiff !== 0) return priorityDiff
      const left = a.due_date || '9999-12-31'
      const right = b.due_date || '9999-12-31'
      return left.localeCompare(right)
    })
    .slice(0, 3)

  const dueText = dueToday.length > 0
    ? `${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today`
    : 'No tasks are due today'

  const focusText = topTasks.length > 0
    ? `Your priorities are ${topTasks.map((task, index) => `${index + 1}. ${task.text}`).join(' • ')}`
    : 'Your plate is clear for now'

  const categoryCounts = ['health', 'work', 'personal'].map(category => ({
    category,
    count: pending.filter(task => task.category === category).length,
  })).filter(item => item.count > 0)

  const categoryText = categoryCounts.length > 0
    ? `You currently have ${categoryCounts.map(item => `${item.count} ${item.category}`).join(', ')} in motion`
    : 'There are no active tasks right now'

  return `Good morning sir. ${dueText}. ${focusText}. ${categoryText}. Start with the first priority and keep the momentum steady.`
}

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

    const modelCandidates = ['openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct']

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

      let briefing = buildMorningBriefing(tasks || [])
      let lastError = null

      for (const model of modelCandidates) {
        try {
          const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${nvidiaApiKey}`,
            },
            body: JSON.stringify({
              model,
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
          briefing = data.choices?.[0]?.message?.content || briefing
          break
        } catch (err) {
          lastError = err
          continue
        }
      }

      if (lastError) {
        console.error('NVIDIA brief generation failed:', lastError)
      }

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
