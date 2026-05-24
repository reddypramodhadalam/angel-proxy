// Angel One SmartAPI Proxy
// Deployed on Vercel — forwards requests to Angel One with CORS headers
// This lets your browser app call Angel One without CORS errors

export default async function handler(req, res) {
  // Allow requests from any origin (your trading app)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PrivateKey, X-UserType, X-SourceID, X-ClientLocalIP, X-ClientPublicIP, X-MACAddress");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Get the Angel One endpoint path from query param
  // e.g. /api/proxy?path=/rest/auth/angelbroking/user/v1/loginByPassword
  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: "Missing path parameter" });
  }

  const angelUrl = `https://apiconnect.angelbroking.com${path}`;

  try {
    const response = await fetch(angelUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // Forward all Angel One required headers from the incoming request
        ...(req.headers["x-privatekey"]        && { "X-PrivateKey":        req.headers["x-privatekey"] }),
        ...(req.headers["x-usertype"]          && { "X-UserType":          req.headers["x-usertype"] }),
        ...(req.headers["x-sourceid"]          && { "X-SourceID":          req.headers["x-sourceid"] }),
        ...(req.headers["x-clientlocalip"]     && { "X-ClientLocalIP":     req.headers["x-clientlocalip"] }),
        ...(req.headers["x-clientpublicip"]    && { "X-ClientPublicIP":    req.headers["x-clientpublicip"] }),
        ...(req.headers["x-macaddress"]        && { "X-MACAddress":        req.headers["x-macaddress"] }),
        ...(req.headers["authorization"]       && { "Authorization":       req.headers["authorization"] }),
      },
      ...(req.method !== "GET" && { body: JSON.stringify(req.body) }),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Proxy error", message: error.message });
  }
}
