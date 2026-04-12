// Admin panel Basic Authentication
// Protects /admin/* routes with username and password

export default async (request: Request) => {
  const url = new URL(request.url);

  // Only protect /admin/* routes
  if (!url.pathname.startsWith('/admin')) {
    return;
  }

  // Check for Authorization header
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="NANKAN Admin Panel"',
      },
    });
  }

  // Parse Basic Auth credentials
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = atob(base64Credentials);
  const [username, password] = credentials.split(':');

  // Verify credentials
  // Username: nankan-admin
  // Password: NANKANsecure2025!
  const validUsername = 'nankan-admin';
  const validPassword = 'NANKANsecure2025!';

  if (username === validUsername && password === validPassword) {
    // Authentication successful - allow access
    return;
  }

  // Authentication failed
  return new Response('Invalid credentials', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="NANKAN Admin Panel"',
    },
  });
};

export const config = {
  path: '/admin/*',
};
