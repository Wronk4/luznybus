// Reputacja zgłaszających (Beta-Bernoulli): ile razy zgłoszenie zgadzało się z licznikiem APC
// albo z pewną predykcją. Nowy użytkownik startuje z umiarkowanym zaufaniem (~0.67),
// rzetelni rosną do ~0.9, trolle spadają do ~0.2 (ich waga w filtrze = zaufanie²).
export class Reputation {
  constructor() {
    this.users = new Map();
  }

  get(user) {
    let u = this.users.get(user);
    if (!u) this.users.set(user, (u = { a: 3, b: 1.5, n: 0 }));
    return u;
  }

  trust(user) {
    const u = this.get(user);
    return u.a / (u.a + u.b);
  }

  update(user, reported, actual, weight = 1) {
    const u = this.get(user);
    const diff = Math.abs(reported - actual);
    const ok = diff === 0 ? 1 : diff === 1 ? 0.4 : 0;
    u.a += weight * ok;
    u.b += weight * (1 - ok);
    u.n++;
  }

  summary() {
    let trusted = 0, untrusted = 0, total = 0;
    for (const [, u] of this.users) {
      total++;
      const t = u.a / (u.a + u.b);
      if (u.n >= 3 && t > 0.75) trusted++;
      if (u.n >= 3 && t < 0.45) untrusted++;
    }
    return { total, trusted, untrusted };
  }
}
