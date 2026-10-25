import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountRouter from "./account";
import { requireAuth } from "../middlewares/requireAuth";
import scanUploadRouter from "./scan-upload";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountRouter);
router.use(requireAuth, scanUploadRouter);

export default router;
