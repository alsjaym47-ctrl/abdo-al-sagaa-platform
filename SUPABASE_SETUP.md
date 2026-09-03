# Supabase Setup — منصة عبده السجاعي

هذا الملف يشرح ربط المشروع بقاعدة Supabase الموجودة لديك. المشروع يستخدم **Supabase Postgres** لبيانات المنصة و**Supabase Storage عبر S3** للملفات الخاصة.

## 1) قاعدة البيانات

من Supabase افتح:

`Project Settings → Database`

انسخ Connection String المناسبة إلى:

```env
DATABASE_URL=...
DIRECT_URL=...
```

لـ Prisma يفضّل استخدام اتصال مناسب للتطبيق في `DATABASE_URL`، والاتصال المباشر في `DIRECT_URL` لعمليات migration عندما توفره لوحة Supabase.

## 2) Project URL

ضع:

```env
SUPABASE_PROJECT_URL=https://YOUR_PROJECT_REF.supabase.co
```

ولا تضف `/rest/v1/`.

## 3) Storage Buckets

افتح `SQL Editor` وشغّل الملف:

`supabase/setup.sql`

سيتم إنشاء 3 Buckets خاصة:

- `course-videos` — فيديوهات الدروس، حد أقصى 2GB للملف.
- `course-documents` — ملفات PDF، حد أقصى 100MB.
- `platform-images` — الصور.

الـ buckets **Private** عمدًا. التطبيق لا يعتمد على روابط عامة للملفات.

## 4) S3 credentials

من Supabase افتح:

`Storage → Configuration → S3`

فعّل S3 protocol وأنشئ Access Key وSecret Access Key. Supabase توضح أن هذه المفاتيح مخصصة للاستخدام server-side لأنها تملك وصولًا كاملًا إلى عمليات S3. لا تضعها في React ولا في Git. urlSupabase S3 Authenticationhttps://supabase.com/docs/guides/storage/s3/authentication

ضع القيم في `.env`:

```env
STORAGE_PROVIDER=s3
STORAGE_BUCKET=course-videos
STORAGE_REGION=YOUR_SUPABASE_REGION
STORAGE_ENDPOINT=https://YOUR_PROJECT_REF.storage.supabase.co/storage/v1/s3
STORAGE_ACCESS_KEY_ID=YOUR_S3_ACCESS_KEY
STORAGE_SECRET_ACCESS_KEY=YOUR_S3_SECRET
STORAGE_FORCE_PATH_STYLE=true
```

يمكنك إنشاء Bucket آخر للفيديوهات والمستندات، لكن التطبيق الحالي يحتاج تمرير اسم الـ bucket المناسب حسب نوع الملف عند استكمال رفع المحتوى.

## 5) اختبار قاعدة البيانات

بعد وضع المتغيرات:

```bash
npm install
npm --workspace server run prisma:generate
npm --workspace server run prisma:migrate:deploy
npm --workspace server run prisma:seed
npm run build
```

إذا كنت تستخدم Supabase مباشرة بدون Docker، شغّل API ثم الواجهة.

## 6) ملاحظات أمنية

- لا تستخدم `service_role` أو S3 Secret في الواجهة.
- لا تجعل buckets الخاصة بالمحتوى Public.
- روابط الوسائط يجب أن تبقى قصيرة العمر ومربوطة بالجلسة.
- Supabase S3 يدعم presigned URLs، والمشروع يستخدم S3 presigning للوسائط عند تفعيل التخزين البعيد.
- Supabase يوصي باستخدام hostname المباشر للتخزين عند رفع الملفات الكبيرة لتحسين الأداء. citeturn0search0turn0search1
