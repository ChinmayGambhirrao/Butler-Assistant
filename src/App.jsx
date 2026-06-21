import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase'
import Auth from './Auth'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const canSpeech = !!SpeechRecognition

const CATEGORIES = ['health', 'work', 'personal']
const CATEGORY_COLORS = { health: 'rose', work: 'blue', personal: 'amber' }
const CATEGORY_LABELS = { health: 'Health', work: 'Work', personal: 'Personal' }

const SYSTEM_PROMPT = `You are a personal butler assistant. You manage the user's task list across three categories: Health, Work, and Personal. You respond in a warm, conversational tone — like a respectful and efficient butler. Address the user as "sir".

When the user asks what's on their plate, give a morning-briefing style response — natural, flowing, not bullet points.

You will receive the current task list as JSON in every message. Each task has: text, completed (boolean), priority (low/medium/high), due_date (YYYY-MM-DD or null), is_recurring (boolean — true for daily repeating tasks like "Drink water").

Based on the user's message, you must:
1. Respond conversationally as a butler
2. Return an updated task list if anything changed. Preserve existing tasks the user didn't mention.

CRITICAL: When the user asks to ADD a task, include it with completed: false. If they say "daily" or "every day" or "recurring", set is_recurring: true. When they ask to REMOVE a task, omit it from the list. When they MARK a task as done, set completed: true. When they ask to UNDO a removal, add the task back.

ALWAYS respond ONLY with valid JSON. Never add text before or after the JSON object. Never add markdown. Never use single quotes. Use this exact format:
{
  "message": "Your warm butler response here, addressing the user as sir",
  "tasks": {
    "health": [{"text": "task", "completed": false, "priority": "medium", "due_date": null, "is_recurring": false}],
    "work": [],
    "personal": []
  }
}`

const WEEKLY_REVIEW_PROMPT = `You are a personal butler assistant giving a weekly performance review. Address the user as "sir". 

You will receive data about the user's completed tasks over the past 7 days, including total count, breakdown by category (Health, Work, Personal), their current streak of consecutive days with at least one task completed, their most completed task, and how many tasks are still pending.

Give a warm, conversational, encouraging summary. Mention total tasks completed, which category was strongest, the current streak, the most completed task, what's still pending, and end with an encouraging note for the week ahead. Keep it flowing naturally — not like a report.

Respond ONLY with the message text, no JSON wrapper.`

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  const today = new Date(todayStr() + 'T00:00:00')
  const diff = Math.round((d - today) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`
}

function priorityColor(priority) {
  return ({ high: 'text-red-400', medium: 'text-amber-400', low: 'text-slate-400' })[priority] || 'text-amber-400'
}

function catColor(cat) {
  return ({ rose: 'bg-rose-900/40 border-rose-700 text-rose-200', blue: 'bg-blue-900/40 border-blue-700 text-blue-200', amber: 'bg-amber-900/40 border-amber-700 text-amber-200' })[cat] || 'bg-blue-900/40 border-blue-700 text-blue-200'
}

function catBadge(cat) {
  return ({ rose: 'bg-rose-600', blue: 'bg-blue-600', amber: 'bg-amber-600' })[cat] || 'bg-blue-600'
}

function catChartColor(cat) {
  return ({ rose: '#f43f5e', blue: '#3b82f6', amber: '#f59e0b' })[cat] || '#3b82f6'
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4)
  const data = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(data.split('').map(c => c.charCodeAt(0)))
}

function computeStreak(tasks) {
  const dates = new Set(tasks.filter(t => t.completed_at).map(t => t.completed_at.slice(0, 10)))
  const today = todayStr()
  let check = today
  if (!dates.has(today)) {
    const d = new Date(today + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    check = d.toISOString().slice(0, 10)
  }
  let streak = 0
  while (dates.has(check)) {
    streak++
    const d = new Date(check + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    check = d.toISOString().slice(0, 10)
  }
  return streak
}

function parseButlerJSON(content) {
  let cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  const tryParse = (str) => {
    try {
      const parsed = JSON.parse(str)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
    return null
  }

  let result = tryParse(cleaned)
  if (result?.message) return result

  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = cleaned.slice(first, last + 1)

    result = tryParse(candidate)
    if (result?.message) return result

    const fixedKeys = candidate.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    result = tryParse(fixedKeys)
    if (result?.message) return result

    const unquoted = fixedKeys.replace(/:\s*'([^']*)'/g, ':"$1"')
    result = tryParse(unquoted)
    if (result?.message) return result

    const doubleQuoted = fixedKeys.replace(/'/g, '"')
    result = tryParse(doubleQuoted)
    if (result?.message) return result
  }

  return { message: cleaned, tasks: null }
}

function mostCompletedTask(tasks) {
  const counts = {}
  tasks.filter(t => t.completed).forEach(t => { counts[t.text] = (counts[t.text] || 0) + 1 })
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return entries.length > 0 ? { text: entries[0][0], count: entries[0][1] } : null
}

export default function App() {
  const [session, setSession] = useState(null)
  const [tasks, setTasks] = useState([])
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [greetingShown, setGreetingShown] = useState(false)
  const [configError, setConfigError] = useState(null)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [listening, setListening] = useState(false)
  const [pushStatus, setPushStatus] = useState('idle')
  const chatEnd = useRef(null)
  const inputRef = useRef(null)
  const recognition = useRef(null)

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!url || !key || url === 'your_supabase_url_here') {
      setConfigError('Supabase is not configured. See SETUP.md for instructions.')
      return
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    loadTasks()
  }, [session])

  async function loadTasks() {
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: true })
    if (data) setTasks(data)
  }

  useEffect(() => {
    if (!session || greetingShown) return
    setGreetingShown(true)
    ;(async () => {
      await resetRecurringTasks()
      const dueToday = tasks.filter(t => t.due_date === todayStr() && !t.completed)
      const dueBrief = dueToday.length > 0 ? ` You have ${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today.` : ''
      setMessages([{ role: 'butler', text: `${getGreeting()} sir.${dueBrief} How can I assist you?` }])
    })()
  }, [session, tasks, greetingShown])

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!session) return
    ;(async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setPushStatus('unsupported')
        return
      }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js')
        const { data: existing } = await supabase
          .from('push_subscriptions')
          .select('id')
          .eq('user_id', session.user.id)
          .maybeSingle()
        if (existing) { setPushStatus('subscribed'); return }
        const perm = await Notification.requestPermission()
        if (perm !== 'granted') { setPushStatus('denied'); return }
        const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
        if (!vapidKey || vapidKey === 'your_vapid_public_key_here') { setPushStatus('no-key'); return }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        })
        await supabase.from('push_subscriptions').upsert({
          user_id: session.user.id,
          subscription: JSON.parse(JSON.stringify(sub)),
        })
        setPushStatus('subscribed')
      } catch { setPushStatus('error') }
    })()
  }, [session])

  async function resetRecurringTasks() {
    const last = localStorage.getItem('lastRecurringReset')
    if (last === todayStr()) return
    const { data: recurring } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', session.user.id)
      .eq('is_recurring', true)
      .eq('completed', true)
    if (recurring && recurring.length > 0) {
      await Promise.all(recurring.map(t =>
        supabase.from('tasks').update({ completed: false, completed_at: null }).eq('id', t.id)
      ))
      await loadTasks()
    }
    localStorage.setItem('lastRecurringReset', todayStr())
  }

  const callNvidia = useCallback(async (body) => {
    const isProd = import.meta.env.PROD
    const url = isProd ? '/api/chat' : '/nvidia-api/chat/completions'
    const headers = {
      'Content-Type': 'application/json',
      ...(isProd ? {} : { 'Authorization': `Bearer ${import.meta.env.VITE_NVIDIA_API_KEY}` }),
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${err.slice(0, 200)}`)
    }
    return await res.json()
  }, [])

  async function syncTasks(aiTaskMap) {
    const ops = []
    for (const category of CATEGORIES) {
      const aiList = aiTaskMap[category] || []
      const dbList = tasks.filter(t => t.category === category)
      const aiTexts = aiList.map(t => (typeof t === 'string' ? t : t.text))

      for (const dbTask of dbList) {
        if (!aiTexts.includes(dbTask.text)) {
          ops.push(supabase.from('tasks').delete().eq('id', dbTask.id))
        }
      }

      for (const aiItem of aiList) {
        const isStr = typeof aiItem === 'string'
        const aiText = isStr ? aiItem : aiItem.text
        const aiCompleted = isStr ? false : (aiItem.completed ?? false)
        const aiPriority = isStr ? 'medium' : (aiItem.priority || 'medium')
        const aiDue = isStr ? null : (aiItem.due_date || null)
        const aiRecurring = isStr ? false : (aiItem.is_recurring ?? false)

        const existing = dbList.find(t => t.text === aiText)
        if (existing) {
          if (existing.completed !== aiCompleted || existing.priority !== aiPriority ||
              existing.due_date !== aiDue || existing.is_recurring !== aiRecurring) {
            ops.push(supabase.from('tasks').update({
              completed: aiCompleted,
              completed_at: aiCompleted ? new Date().toISOString() : null,
              priority: aiPriority,
              due_date: aiDue,
              is_recurring: aiRecurring,
            }).eq('id', existing.id))
          }
        } else {
          ops.push(supabase.from('tasks').insert({
            user_id: session.user.id,
            text: aiText,
            category,
            completed: aiCompleted,
            priority: aiPriority,
            due_date: aiDue,
            is_recurring: aiRecurring,
          }))
        }
      }
    }
    await Promise.all(ops)
    await loadTasks()
  }

  async function handleWeeklyReview() {
    const weekAgo = daysAgo(7)
    const twoWeeksAgo = daysAgo(14)

    const { data: completedThisWeek } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', session.user.id)
      .gte('completed_at', weekAgo)
      .eq('completed', true)

    const { data: completedLastWeek } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', session.user.id)
      .lt('completed_at', weekAgo)
      .gte('completed_at', twoWeeksAgo)
      .eq('completed', true)

    const thisWeek = completedThisWeek || []
    const lastWeek = completedLastWeek || []
    const pending = tasks.filter(t => !t.completed)

    const catCounts = {}
    for (const cat of CATEGORIES) {
      catCounts[cat] = thisWeek.filter(t => t.category === cat).length
    }
    const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]
    const streak = computeStreak(tasks)
    const topTask = mostCompletedTask(tasks)

    const dataForAI = {
      total_completed_this_week: thisWeek.length,
      total_completed_last_week: lastWeek.length,
      category_breakdown: catCounts,
      strongest_category: topCat ? topCat[0] : 'N/A',
      current_streak_days: streak,
      most_completed_task: topTask ? `${topTask.text} (${topTask.count}x)` : 'N/A',
      pending_tasks: pending.length,
    }

    try {
      const completion = await callNvidia({
        model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        messages: [
          { role: 'system', content: WEEKLY_REVIEW_PROMPT },
          { role: 'user', content: `Here is my weekly data: ${JSON.stringify(dataForAI)}` },
        ],
        temperature: 0.7,
      })
      const text = completion.choices?.[0]?.message?.content || 'Here is your weekly summary sir.'
      setMessages(prev => [...prev, { role: 'butler', text }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'butler',
        text: `I apologize sir, I couldn't compile your weekly review. ${err.message}`,
      }])
    }
  }

  async function handleSend(e) {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: trimmed }])
    setLoading(true)

    if (/\b(week|weekly)\b/i.test(trimmed)) {
      await handleWeeklyReview()
      setLoading(false)
      return
    }

    const tasksByCat = {}
    for (const cat of CATEGORIES) {
      tasksByCat[cat] = tasks.filter(t => t.category === cat).map(t => ({
        text: t.text, completed: t.completed, priority: t.priority,
        due_date: t.due_date, is_recurring: t.is_recurring,
      }))
    }

    const userContent = `Current tasks: ${JSON.stringify(tasksByCat)}\nUser said: ${trimmed}`

    try {
      const completion = await callNvidia({
        model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.7,
      })

      const content = completion.choices?.[0]?.message?.content
      if (!content) throw new Error('Empty response from API')

      const parsed = parseButlerJSON(content)

      setMessages(prev => [...prev, { role: 'butler', text: parsed.message }])
      if (parsed.tasks) await syncTasks(parsed.tasks)
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'butler',
        text: `I apologize sir, but I encountered an issue: ${err.message}. Please try again.`,
      }])
    } finally {
      setLoading(false)
    }
  }

  async function toggleTask(task) {
    const next = !task.completed
    await supabase.from('tasks').update({
      completed: next,
      completed_at: next ? new Date().toISOString() : null,
    }).eq('id', task.id)
    await loadTasks()
  }

  async function deleteTask(task) {
    await supabase.from('tasks').delete().eq('id', task.id)
    await loadTasks()
  }

  function startSpeech() {
    if (!canSpeech || listening) return
    const sr = new SpeechRecognition()
    sr.lang = 'en-US'
    sr.interimResults = false
    sr.onresult = (e) => {
      const transcript = e.results[0][0].transcript
      setInput('')
      setListening(false)
      setTimeout(() => {
        setMessages(prev => [...prev, { role: 'user', text: transcript }])
        setLoading(true)
        const syntheticEvent = { preventDefault: () => {} }
        handleSend.__synthetic = { ...handleSend }
      }, 100)
      setInput(transcript)
      setTimeout(() => {
        document.querySelector('form')?.requestSubmit()
      }, 300)
    }
    sr.onerror = () => setListening(false)
    sr.onend = () => setListening(false)
    sr.start()
    recognition.current = sr
    setListening(true)
  }

  function stopSpeech() {
    if (recognition.current) {
      recognition.current.stop()
      recognition.current = null
    }
    setListening(false)
  }

  const dueToday = tasks.filter(t => t.due_date === todayStr() && !t.completed).length
  const totalTasks = tasks.filter(t => !t.completed).length

  const completedThisWeek = tasks.filter(t => t.completed && t.completed_at >= daysAgo(7)).length
  const completedLastWeek = tasks.filter(t => t.completed && t.completed_at >= daysAgo(14) && t.completed_at < daysAgo(7)).length
  const weekChange = completedLastWeek > 0 ? Math.round((completedThisWeek - completedLastWeek) / completedLastWeek * 100) : completedThisWeek > 0 ? 100 : 0
  const streak = computeStreak(tasks)
  const topTask = mostCompletedTask(tasks)
  const weeklyChartData = CATEGORIES.map(cat => ({
    name: CATEGORY_LABELS[cat],
    completed: tasks.filter(t => t.completed && t.category === cat && t.completed_at >= daysAgo(7)).length,
    fill: catChartColor(cat),
  }))

  if (configError) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <span className="text-5xl block mb-4">🕴️</span>
          <h1 className="text-xl font-bold text-slate-100 mb-2">Configuration Needed</h1>
          <p className="text-slate-400 text-sm">{configError}</p>
          <p className="text-slate-500 text-xs mt-3">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env</p>
        </div>
      </div>
    )
  }

  if (session === null) {
    return <Auth />
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      <header className="bg-slate-800 border-b border-slate-700 px-4 md:px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🕴️</span>
          <h1 className="text-lg font-semibold tracking-tight">Butler Assistant</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          {dueToday > 0 && (
            <span className="text-amber-400 text-xs bg-amber-900/30 px-2 py-1 rounded-full">
              {dueToday} due today
            </span>
          )}
          <span>{totalTasks} active</span>
          <button
            onClick={() => setShowAnalytics(true)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            title="Analytics"
          >
            📊
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 bg-slate-800/50 border-r border-slate-700 hidden md:flex flex-col p-4 gap-3 shrink-0 overflow-y-auto">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Categories</h2>
          {CATEGORIES.map(cat => {
            const catTasks = tasks.filter(t => t.category === cat && !t.completed)
            const colorKey = CATEGORY_COLORS[cat]
            return (
              <div key={cat} className={`rounded-lg border p-3 ${catColor(colorKey)}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium capitalize">{cat}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full text-white ${catBadge(colorKey)}`}>
                    {catTasks.length}
                  </span>
                </div>
                {catTasks.length > 0 ? (
                  <div className="space-y-1.5">
                    {catTasks.map(task => (
                      <div key={task.id} className="flex items-start gap-2 group">
                        <input
                          type="checkbox"
                          checked={task.completed}
                          onChange={() => toggleTask(task)}
                          className="mt-0.5 shrink-0 accent-indigo-500 cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs">
                            {task.text}
                            {task.is_recurring && <span className="ml-1 text-[10px]" title="Repeats daily">🔁</span>}
                          </span>
                          <div className="flex gap-2 text-[10px] mt-0.5">
                            {task.priority && task.priority !== 'medium' && (
                              <span className={priorityColor(task.priority)}>{task.priority}</span>
                            )}
                            {task.due_date && (
                              <span className="text-slate-400">{formatDate(task.due_date)}</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => deleteTask(task)}
                          className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all text-xs shrink-0"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs opacity-60 italic">No tasks</p>
                )}
              </div>
            )
          })}
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} fade-in`}>
                <div
                  className={`max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-md'
                      : 'bg-slate-700 text-slate-100 rounded-bl-md'
                  }`}
                >
                  {msg.role === 'butler' && (
                    <span className="text-xs text-slate-400 block mb-1">🕴️ Butler</span>
                  )}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start fade-in">
                <div className="bg-slate-700 rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">🕴️</span>
                    <span className="loading-dot w-1.5 h-1.5 bg-slate-300 rounded-full inline-block" />
                    <span className="loading-dot w-1.5 h-1.5 bg-slate-300 rounded-full inline-block" />
                    <span className="loading-dot w-1.5 h-1.5 bg-slate-300 rounded-full inline-block" />
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEnd} />
          </div>

          <form
            onSubmit={handleSend}
            className="border-t border-slate-700 bg-slate-800 px-4 md:px-6 py-3 shrink-0"
          >
            <div className="flex gap-3 max-w-4xl mx-auto">
              <div className="flex-1 flex items-center gap-2 bg-slate-700 rounded-xl border border-slate-600 focus-within:ring-2 focus-within:ring-indigo-500">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Tell your butler what to do..."
                  disabled={loading}
                  className="flex-1 bg-transparent text-slate-100 px-4 py-2.5 text-sm outline-none placeholder-slate-400 disabled:opacity-50"
                />
                {canSpeech ? (
                  <button
                    type="button"
                    onClick={listening ? stopSpeech : startSpeech}
                    className={`px-2 transition-colors ${listening ? 'mic-listening text-indigo-400 rounded-full' : 'text-slate-400 hover:text-slate-200'}`}
                    title={listening ? 'Stop listening' : 'Voice input'}
                  >
                    {listening ? '🎤' : '🎤'}
                  </button>
                ) : (
                  <span className="px-2 text-slate-600 text-xs cursor-default" title="Voice not supported on this browser">🎤</span>
                )}
              </div>
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-600 text-white rounded-xl px-5 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </form>
        </main>
      </div>

      {showAnalytics && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setShowAnalytics(false)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-md bg-slate-800 border-l border-slate-700 z-50 analytics-panel overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold">📊 Analytics</h2>
              <button onClick={() => setShowAnalytics(false)} className="text-slate-400 hover:text-slate-200 text-xl">&times;</button>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-indigo-400">{completedThisWeek}</p>
                  <p className="text-xs text-slate-400 mt-1">This week</p>
                </div>
                <div className="bg-slate-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-slate-300">{completedLastWeek}</p>
                  <p className="text-xs text-slate-400 mt-1">Last week</p>
                </div>
              </div>
              {completedThisWeek + completedLastWeek > 0 && (
                <div className="bg-slate-700/50 rounded-xl p-3 text-center">
                  <span className={`text-sm font-medium ${weekChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {weekChange >= 0 ? '↑' : '↓'} {Math.abs(weekChange)}% vs last week
                  </span>
                </div>
              )}

              <div>
                <h3 className="text-sm font-medium text-slate-300 mb-3">Category breakdown (this week)</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weeklyChartData}>
                      <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: '#e2e8f0' }}
                      />
                      <Bar dataKey="completed" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-amber-400">{streak}</p>
                  <p className="text-xs text-slate-400 mt-1">Day streak</p>
                </div>
                <div className="bg-slate-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-400">{topTask ? topTask.count : 0}</p>
                  <p className="text-xs text-slate-400 mt-1">Most completed</p>
                  {topTask && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{topTask.text}</p>}
                </div>
              </div>

              <div className="bg-slate-700/50 rounded-xl p-4">
                <h3 className="text-sm font-medium text-slate-300 mb-2">🔔 Morning Push</h3>
                <p className="text-xs text-slate-400 mb-2">
                  {pushStatus === 'subscribed' && 'Daily morning briefing is active at 7 AM IST'}
                  {pushStatus === 'denied' && 'Notifications were blocked. Enable in browser settings.'}
                  {pushStatus === 'unsupported' && 'Push notifications not supported on this browser.'}
                  {pushStatus === 'no-key' && 'Set VITE_VAPID_PUBLIC_KEY in .env for morning push.'}
                  {pushStatus === 'error' && 'Could not set up push notifications.'}
                  {pushStatus === 'idle' && 'Setting up morning push...'}
                </p>
                <button
                  onClick={async () => {
                    await supabase.from('push_subscriptions').delete().eq('user_id', session.user.id)
                    setPushStatus('idle')
                  }}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Unsubscribe
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
