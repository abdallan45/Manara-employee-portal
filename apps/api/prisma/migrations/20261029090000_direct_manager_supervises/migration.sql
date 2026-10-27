-- A direct manager now supervises their reports automatically (derived from employees.manager_id), so the
-- explicit rows naming the current direct manager are redundant; kept, they would leave access behind when
-- the manager changes.
DELETE FROM employee_supervisors s USING employees e, users u WHERE s.employee_id = e.id AND u.employee_id = e.manager_id AND s.supervisor_user_id = u.id;
