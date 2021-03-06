import express from "express";
import Teacher from "models/teacher.model";
const router = express.Router();

router.get("/", async (req, res) => {
  const teachers = await Teacher.query();

  res.status(200).json(teachers);
});

export default router;
