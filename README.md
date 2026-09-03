# منصة عبده السجاعي التعليمية

مشروع تأسيسي قابل للتوسعة لمنصة تعليمية عربية مع لوحة إدارة وAPI.

## التشغيل

```bash
npm install
npm run dev
```

- Client: http://localhost:5173
- API: http://localhost:4000/api/health

## بيانات الأدمن المحلية للتطوير فقط
- email: `admin@abdo.local`
- password: `ChangeMe123!`

غيّرها فور ربط قاعدة البيانات والإنتاج.

## أهم الملفات
- `docs/IMPLEMENTATION.md` — سجل التنفيذ ونقطة التوقف الحالية.
- `docs/REQUIREMENTS.md` — ملخص المتطلبات المرجعية.
- `docs/SPECKIT_RULES.md` — قواعد Speckit.
- `prisma/schema.prisma` — قاعدة PostgreSQL الأولية.
- `client/` — React/Vite.
- `server/` — Express API.

## ملاحظة أمنية
حماية المتصفح من تسجيل الشاشة أو DevTools ليست ضمانًا مطلقًا من داخل JavaScript. التصميم النهائي يعتمد على DRM/CDN/روابط موقعة/Watermark ومراقبة سلوك العميل وتسجيل المخالفات، مع اختبار أمني فعلي.

## الاستكمال من آخر نقطة
ابدأ من `docs/IMPLEMENTATION.md`. لا تفترض أن الـ build ناجح: في بيئة الإنشاء الحالية تم تسجيل فشل التثبيت بسبب timeout. في بيئة تطوير عادية نفّذ:

```bash
npm install
npm run build
docker compose up --build
```

ثم نفّذ Prisma migration/seed واربط الـ API بقاعدة البيانات قبل اعتبار النظام جاهزاً للإنتاج.

## Supabase

لربط المشروع بقاعدة Supabase وStorage راجع `docs/SUPABASE_SETUP.md` وشغّل `supabase/setup.sql` من SQL Editor.
