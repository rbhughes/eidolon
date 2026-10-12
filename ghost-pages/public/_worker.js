// The whole ghost.purr.io Pages project: hand every request to the
// eidolon Worker over a service binding.
//
// Why the indirection: purr.io's DNS is on Route53, and only Pages (not
// Workers) accepts a custom domain on a zone Cloudflare doesn't manage
// (Workers custom domains need an active Cloudflare zone; subdomain
// zones are Enterprise-only). But the app itself can't run on Pages --
// @astrojs/cloudflare 14 builds Workers only, and Pages doesn't support
// the native "ratelimits" binding the app relies on. So the app stays a
// Worker (with no public workers.dev URL) and this forwards to it. The
// request object is passed through untouched, so cf-connecting-ip -- the
// rate limiter's key -- arrives intact.
export default {
  fetch(request, env) {
    return env.EIDOLON.fetch(request);
  }
};
