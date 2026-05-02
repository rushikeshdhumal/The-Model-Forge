import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sessionRouter from "./session";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionRouter);

export default router;
