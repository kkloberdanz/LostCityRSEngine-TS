// Imported first by Harness.ts so these win over engine/.env (dotenv never overrides existing vars).
// The harness runs the world in-process with no login/friend/logger servers and its own save folder.
process.env.NODE_PROFILE ??= 'harness';
process.env.LOGIN_SERVER = 'false';
process.env.FRIEND_SERVER = 'false';
process.env.LOGGER_SERVER = 'false';
process.env.EASY_STARTUP = 'false';
process.env.NODE_PRODUCTION = 'false'; // keep dev behaviour: script errors don't kick, "No trigger for ..." messages
process.env.NODE_DEBUG = 'true';
process.env.BUILD_STARTUP = 'false';
process.env.NODE_MEMBERS = 'true';
