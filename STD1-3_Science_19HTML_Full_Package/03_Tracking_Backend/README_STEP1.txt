STD 1–3 SCIENCE TRACKING SYSTEM — STEP 1
==============================================

FILES
-----
1. schema.sql
   Creates the real Cloudflare D1 database tables for:
   students, units, attempts, answers, skill_summary.

2. worker.js
   API for:
   - student identity
   - start attempt
   - save every answer
   - finish attempt
   - student progress
   - teacher student list
   - teacher detailed report
   - weak-skill analysis + remediation

IMPORTANT
---------
This is REAL cloud saving when deployed to Cloudflare Worker + D1.
It is not localStorage.

Required Worker bindings / variables:
- D1 binding name: DB
- Secret: TEACHER_KEY
- Variable: ALLOWED_ORIGINS
  Example:
  https://yourdomain.com,https://yourproject.pages.dev

Main endpoints:
POST /api/student
POST /api/attempt/start
POST /api/answer
POST /api/attempt/finish
GET  /api/student/progress?name=...&grade=...
GET  /api/teacher/students
GET  /api/teacher/student?name=...&grade=...

Teacher endpoints require:
X-Teacher-Key: <your secret>
