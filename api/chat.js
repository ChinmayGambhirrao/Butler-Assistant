export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.NVIDIA_API_KEY

  if (!apiKey) {
    return res.status(500).json({ error: 'NVIDIA_API_KEY not configured on server' })
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const modelCandidates = ['openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct']

    let lastError = null
    for (const model of modelCandidates) {
      try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ ...body, model }),
        })

        const text = await response.text()
        if (!response.ok) {
          lastError = new Error(`API error ${response.status}: ${text.slice(0, 200)}`)
          continue
        }

        try {
          const data = JSON.parse(text)
          return res.status(response.status).json(data)
        } catch {
          return res.status(response.status).send(text)
        }
      } catch (err) {
        lastError = err
      }
    }

    return res.status(502).json({ error: lastError ? lastError.message : 'NVIDIA API request failed' })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
}
