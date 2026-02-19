CREATE TABLE IF NOT EXISTS notes
(
    id
    INT
    AUTO_INCREMENT
    PRIMARY
    KEY,
    title
    VARCHAR
(
    255
) NOT NULL,
    content TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

CREATE TABLE IF NOT EXISTS note_locks
(
    note_id
    INT
    PRIMARY
    KEY,
    locked_by
    VARCHAR
(
    64
) NOT NULL,
    locked_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    CONSTRAINT fk_note_locks_note
    FOREIGN KEY
(
    note_id
) REFERENCES notes
(
    id
) ON DELETE CASCADE
    );

INSERT INTO notes (title, content)
VALUES ('Meeting notes', 'Discuss architecture'),
       ('Call script', 'Intro, value prop, objections'),
       ('To-do', '1) Ship MVP 2) Sleep');
