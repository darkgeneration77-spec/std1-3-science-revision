PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 3),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_code TEXT NOT NULL UNIQUE,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 3),
  unit_no INTEGER NOT NULL,
  title_zh TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  unit_code TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  total_questions INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  score_percent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (unit_code) REFERENCES units(unit_code),
  UNIQUE(student_id, unit_code, attempt_no)
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  selected_answer TEXT,
  correct_answer TEXT NOT NULL,
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  skill_code TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
  UNIQUE(attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS skill_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  unit_code TEXT NOT NULL,
  skill_code TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  total_answers INTEGER NOT NULL DEFAULT 0,
  correct_answers INTEGER NOT NULL DEFAULT 0,
  wrong_answers INTEGER NOT NULL DEFAULT 0,
  accuracy REAL NOT NULL DEFAULT 0,
  mastery TEXT NOT NULL DEFAULT 'not_started',
  remediation TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  UNIQUE(student_id, unit_code, skill_code)
);

CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_unit ON attempts(unit_code);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_answers_skill ON answers(skill_code);
CREATE INDEX IF NOT EXISTS idx_skill_student ON skill_summary(student_id);

INSERT OR IGNORE INTO units (unit_code, grade, unit_no, title_zh) VALUES
('S1U4',1,4,'人类'),
('S1U5',1,5,'动物'),
('S1U6',1,6,'植物'),
('S1U7',1,7,'磁铁'),
('S1U8',1,8,'吸水'),

('S2U3',2,3,'人类'),
('S2U4',2,4,'动物'),
('S2U5',2,5,'植物'),
('S2U6',2,6,'光和暗'),
('S2U7',2,7,'电'),
('S2U8',2,8,'混合物'),
('S2U9',2,9,'地球'),
('S2U10',2,10,'工艺'),

('S3U3',3,3,'人类'),
('S3U4',3,4,'动物'),
('S3U5',3,5,'植物'),
('S3U7',3,7,'密度'),
('S3U8',3,8,'酸与碱'),
('S3U10',3,10,'机械');
