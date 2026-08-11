const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function studentKey(name, grade) {
  return `${grade}:${normalizeName(name).toLowerCase()}`;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  // 如果暂时没有设定 ALLOWED_ORIGINS，允许所有来源，方便初次测试。
  // 正式上线后务必在 Worker Variables 加入你的真实网站域名。
  const allowOrigin = allowed.length === 0
    ? "*"
    : (allowed.includes(origin) ? origin : allowed[0]);

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Teacher-Key",
    "Access-Control-Max-Age": "86400"
  };
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  Object.entries(corsHeaders(request, env)).forEach(([k,v]) => h.set(k,v));
  return new Response(response.body, { status: response.status, headers: h });
}

async function bodyJSON(request) {
  try { return await request.json(); }
  catch { throw new Error("INVALID_JSON"); }
}

function cleanText(v, max = 1000) {
  return String(v ?? "").trim().slice(0, max);
}

function masteryFromAccuracy(accuracy, total) {
  if (!total) return "not_started";
  if (accuracy >= 80) return "mastered";
  if (accuracy >= 60) return "developing";
  return "weak";
}

function remediationFor(skillName, accuracy) {
  if (accuracy >= 80) return `已掌握「${skillName}」。可进入下一知识点，并安排少量复习题保持熟练度。`;
  if (accuracy >= 60) return `「${skillName}」仍不稳定。建议先重看该知识点的关键规则或实验现象，再完成 5 题针对练习，达到 80% 后再标记为掌握。`;
  return `「${skillName}」是目前主要弱项。建议重新教学该概念，用图解或实物实验示范，再做 3 题基础辨认 + 5 题针对练习；错误题必须订正，并在重测达到 80% 后才进入下一阶段。`;
}

async function getOrCreateStudent(env, name, grade) {
  name = normalizeName(name);
  grade = Number(grade);
  if (!name || name.length > 80 || ![1,2,3].includes(grade)) {
    throw new Error("INVALID_STUDENT");
  }
  const key = studentKey(name, grade);

  await env.DB.prepare(`
    INSERT INTO students (student_key, name, grade, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(student_key) DO UPDATE SET
      name = excluded.name,
      updated_at = CURRENT_TIMESTAMP
  `).bind(key, name, grade).run();

  return await env.DB.prepare(
    "SELECT id, student_key, name, grade FROM students WHERE student_key = ?"
  ).bind(key).first();
}

async function refreshSkillSummary(env, studentId, unitCode, skillCode, skillName) {
  const stat = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(is_correct),0) AS correct
    FROM answers a
    JOIN attempts t ON t.id = a.attempt_id
    WHERE t.student_id = ? AND t.unit_code = ? AND a.skill_code = ?
  `).bind(studentId, unitCode, skillCode).first();

  const total = Number(stat?.total || 0);
  const correct = Number(stat?.correct || 0);
  const wrong = total - correct;
  const accuracy = total ? Math.round((correct / total) * 1000) / 10 : 0;
  const mastery = masteryFromAccuracy(accuracy, total);
  const remediation = remediationFor(skillName, accuracy);

  await env.DB.prepare(`
    INSERT INTO skill_summary
      (student_id, unit_code, skill_code, skill_name,
       total_answers, correct_answers, wrong_answers,
       accuracy, mastery, remediation, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(student_id, unit_code, skill_code) DO UPDATE SET
      skill_name = excluded.skill_name,
      total_answers = excluded.total_answers,
      correct_answers = excluded.correct_answers,
      wrong_answers = excluded.wrong_answers,
      accuracy = excluded.accuracy,
      mastery = excluded.mastery,
      remediation = excluded.remediation,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    studentId, unitCode, skillCode, skillName,
    total, correct, wrong, accuracy, mastery, remediation
  ).run();
}

async function finishAttempt(env, attemptId) {
  const attempt = await env.DB.prepare(`
    SELECT id, student_id, unit_code FROM attempts WHERE id = ?
  `).bind(attemptId).first();
  if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");

  const stat = await env.DB.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(is_correct),0) AS correct
    FROM answers WHERE attempt_id = ?
  `).bind(attemptId).first();

  const total = Number(stat?.total || 0);
  const correct = Number(stat?.correct || 0);
  const wrong = total - correct;
  const score = total ? Math.round((correct / total) * 1000) / 10 : 0;

  await env.DB.prepare(`
    UPDATE attempts SET
      finished_at = CURRENT_TIMESTAMP,
      total_questions = ?,
      correct_count = ?,
      wrong_count = ?,
      score_percent = ?,
      status = 'completed'
    WHERE id = ?
  `).bind(total, correct, wrong, score, attemptId).run();

  const skills = await env.DB.prepare(`
    SELECT DISTINCT skill_code, skill_name
    FROM answers WHERE attempt_id = ?
  `).bind(attemptId).all();

  for (const s of (skills.results || [])) {
    await refreshSkillSummary(
      env, attempt.student_id, attempt.unit_code, s.skill_code, s.skill_name
    );
  }

  return { total, correct, wrong, score_percent: score };
}

function requireTeacher(request, env) {
  const expected = env.TEACHER_KEY || "";
  const given = request.headers.get("X-Teacher-Key") || "";
  return expected && given === expected;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/" && request.method === "GET") {
        response = json({
          ok: true,
          service: "Std 1-3 Science Learning Tracker",
          endpoints: [
            "POST /api/student",
            "POST /api/attempt/start",
            "POST /api/answer",
            "POST /api/attempt/finish",
            "GET /api/student/progress?name=&grade=",
            "GET /api/teacher/students",
            "GET /api/teacher/student?name=&grade="
          ]
        });
      }

      else if (path === "/api/student" && request.method === "POST") {
        const b = await bodyJSON(request);
        const student = await getOrCreateStudent(env, b.name, b.grade);
        response = json({ ok: true, student });
      }

      else if (path === "/api/attempt/start" && request.method === "POST") {
        const b = await bodyJSON(request);
        const student = await getOrCreateStudent(env, b.name, b.grade);
        const unitCode = cleanText(b.unit_code, 20);

        const unit = await env.DB.prepare(
          "SELECT unit_code, grade, unit_no, title_zh FROM units WHERE unit_code = ?"
        ).bind(unitCode).first();

        if (!unit) response = json({ ok:false, error:"UNKNOWN_UNIT" }, 400);
        else if (Number(unit.grade) !== Number(student.grade)) {
          response = json({ ok:false, error:"GRADE_UNIT_MISMATCH" }, 400);
        } else {
          const last = await env.DB.prepare(`
            SELECT MAX(attempt_no) AS n
            FROM attempts WHERE student_id = ? AND unit_code = ?
          `).bind(student.id, unitCode).first();

          const attemptNo = Number(last?.n || 0) + 1;
          const created = await env.DB.prepare(`
            INSERT INTO attempts (student_id, unit_code, attempt_no)
            VALUES (?, ?, ?)
            RETURNING id, attempt_no, started_at
          `).bind(student.id, unitCode, attemptNo).first();

          response = json({
            ok:true,
            student,
            unit,
            attempt:{
              id: created.id,
              attempt_no: created.attempt_no,
              started_at: created.started_at
            }
          });
        }
      }

      else if (path === "/api/answer" && request.method === "POST") {
        const b = await bodyJSON(request);
        const attemptId = Number(b.attempt_id);
        const questionId = cleanText(b.question_id, 80);
        const questionText = cleanText(b.question_text, 1500);
        const selectedAnswer = cleanText(b.selected_answer, 500);
        const correctAnswer = cleanText(b.correct_answer, 500);
        const skillCode = cleanText(b.skill_code, 80);
        const skillName = cleanText(b.skill_name, 150);
        const isCorrect = b.is_correct === true || b.is_correct === 1 ? 1 : 0;

        if (!attemptId || !questionId || !questionText || !correctAnswer || !skillCode || !skillName) {
          response = json({ ok:false, error:"MISSING_FIELDS" }, 400);
        } else {
          const attempt = await env.DB.prepare(`
            SELECT id, student_id, unit_code, status FROM attempts WHERE id = ?
          `).bind(attemptId).first();

          if (!attempt) response = json({ ok:false, error:"ATTEMPT_NOT_FOUND" }, 404);
          else if (attempt.status === "completed") {
            response = json({ ok:false, error:"ATTEMPT_ALREADY_COMPLETED" }, 409);
          } else {
            await env.DB.prepare(`
              INSERT INTO answers
                (attempt_id, question_id, question_text, selected_answer,
                 correct_answer, is_correct, skill_code, skill_name, answered_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(attempt_id, question_id) DO UPDATE SET
                selected_answer = excluded.selected_answer,
                correct_answer = excluded.correct_answer,
                is_correct = excluded.is_correct,
                skill_code = excluded.skill_code,
                skill_name = excluded.skill_name,
                answered_at = CURRENT_TIMESTAMP
            `).bind(
              attemptId, questionId, questionText, selectedAnswer,
              correctAnswer, isCorrect, skillCode, skillName
            ).run();

            await refreshSkillSummary(
              env, attempt.student_id, attempt.unit_code, skillCode, skillName
            );

            response = json({ ok:true, saved:true });
          }
        }
      }

      else if (path === "/api/attempt/finish" && request.method === "POST") {
        const b = await bodyJSON(request);
        const attemptId = Number(b.attempt_id);
        if (!attemptId) response = json({ ok:false, error:"INVALID_ATTEMPT" }, 400);
        else {
          const result = await finishAttempt(env, attemptId);
          response = json({ ok:true, result });
        }
      }

      else if (path === "/api/student/progress" && request.method === "GET") {
        const name = normalizeName(url.searchParams.get("name"));
        const grade = Number(url.searchParams.get("grade"));
        if (!name || ![1,2,3].includes(grade)) {
          response = json({ ok:false, error:"INVALID_STUDENT" }, 400);
        } else {
          const student = await env.DB.prepare(`
            SELECT id,name,grade FROM students WHERE student_key = ?
          `).bind(studentKey(name, grade)).first();

          if (!student) response = json({ ok:true, student:null, attempts:[] });
          else {
            const attempts = await env.DB.prepare(`
              SELECT a.id,a.unit_code,u.unit_no,u.title_zh,a.attempt_no,
                     a.started_at,a.finished_at,a.total_questions,
                     a.correct_count,a.wrong_count,a.score_percent,a.status
              FROM attempts a
              JOIN units u ON u.unit_code=a.unit_code
              WHERE a.student_id=?
              ORDER BY u.unit_no, a.attempt_no DESC
            `).bind(student.id).all();
            response = json({ ok:true, student, attempts:attempts.results || [] });
          }
        }
      }

      else if (path === "/api/teacher/students" && request.method === "GET") {
        if (!requireTeacher(request, env)) response = json({ ok:false,error:"UNAUTHORIZED" },401);
        else {
          const rows = await env.DB.prepare(`
            SELECT
              s.id,s.name,s.grade,
              COUNT(DISTINCT CASE WHEN a.status='completed' THEN a.unit_code END) AS units_completed,
              COUNT(DISTINCT a.id) AS total_attempts,
              ROUND(AVG(CASE WHEN a.status='completed' THEN a.score_percent END),1) AS average_score,
              MAX(a.started_at) AS last_activity
            FROM students s
            LEFT JOIN attempts a ON a.student_id=s.id
            GROUP BY s.id
            ORDER BY s.grade,s.name
          `).all();
          response = json({ ok:true, students:rows.results || [] });
        }
      }

      else if (path === "/api/teacher/student" && request.method === "GET") {
        if (!requireTeacher(request, env)) response = json({ ok:false,error:"UNAUTHORIZED" },401);
        else {
          const name = normalizeName(url.searchParams.get("name"));
          const grade = Number(url.searchParams.get("grade"));
          const student = await env.DB.prepare(`
            SELECT id,name,grade FROM students WHERE student_key = ?
          `).bind(studentKey(name, grade)).first();

          if (!student) response = json({ ok:false,error:"STUDENT_NOT_FOUND" },404);
          else {
            const attempts = await env.DB.prepare(`
              SELECT a.*,u.unit_no,u.title_zh
              FROM attempts a JOIN units u ON u.unit_code=a.unit_code
              WHERE a.student_id=?
              ORDER BY u.unit_no,a.attempt_no DESC
            `).bind(student.id).all();

            const skills = await env.DB.prepare(`
              SELECT unit_code,skill_code,skill_name,total_answers,
                     correct_answers,wrong_answers,accuracy,mastery,
                     remediation,updated_at
              FROM skill_summary
              WHERE student_id=?
              ORDER BY unit_code,accuracy ASC
            `).bind(student.id).all();

            const wrong = await env.DB.prepare(`
              SELECT t.unit_code,t.attempt_no,a.question_id,a.question_text,
                     a.selected_answer,a.correct_answer,a.skill_code,a.skill_name,
                     a.answered_at
              FROM answers a
              JOIN attempts t ON t.id=a.attempt_id
              WHERE t.student_id=? AND a.is_correct=0
              ORDER BY a.answered_at DESC
              LIMIT 300
            `).bind(student.id).all();

            response = json({
              ok:true,
              student,
              attempts:attempts.results || [],
              skills:skills.results || [],
              wrong_answers:wrong.results || []
            });
          }
        }
      }

      else {
        response = json({ ok:false, error:"NOT_FOUND" }, 404);
      }

    } catch (err) {
      const msg = err?.message || "SERVER_ERROR";
      response = json({
        ok:false,
        error: msg === "INVALID_JSON" ? "INVALID_JSON" :
               msg === "INVALID_STUDENT" ? "INVALID_STUDENT" :
               msg === "ATTEMPT_NOT_FOUND" ? "ATTEMPT_NOT_FOUND" :
               "SERVER_ERROR"
      }, msg === "INVALID_JSON" || msg === "INVALID_STUDENT" ? 400 : 500);
    }

    return withCors(response, request, env);
  }
};
